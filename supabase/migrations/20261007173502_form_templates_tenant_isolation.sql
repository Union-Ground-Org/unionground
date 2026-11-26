-- Tenant isolation for the versioned form registry.
-- Existing key/version identities and immutable submitted content are retained.
-- updated_by is last-modifier attribution, not authoring-tenant provenance.
-- Unattributed legacy content stays quarantined until a reviewed operator map
-- establishes its creation scope. This migration never restores active state.

begin;

alter table public.form_templates
  add column organization_id uuid references public.organizations(id),
  add column is_platform_seed boolean not null default false,
  add constraint form_templates_seed_scope_check
    check (not is_platform_seed or organization_id is null);

-- Only the original seven version-1 seed identities are platform reference data.
-- Application RPCs never changed their immutable payloads in place.
update public.form_templates set is_platform_seed = true
where version = 1 and key in ('grievance','fmla_self','fmla_family',
  'alliance_grievance','non_selection','alt_work','service_request');

-- A later version of a canonical key was written by the old global editor, so
-- its authoring organization is unknown. Promoting it would publish one
-- organization's edit everywhere; quarantining it would hide a standard form
-- from every organization. Stop for a reviewed mapping instead.
do $$
begin
  if exists (select 1 from public.form_templates where version > 1 and key in ('grievance',
    'fmla_self','fmla_family','alliance_grievance','non_selection','alt_work','service_request')) then
    raise exception 'canonical form template has a version above 1; map it before tenant isolation'
      using errcode = '55000';
  end if;
end;
$$;

create index form_templates_organization_key_version_idx
  on public.form_templates(organization_id, key, version desc);
create unique index form_templates_organization_active_idx
  on public.form_templates(organization_id,key) where active;

drop policy form_templates_select_all on public.form_templates;
create policy form_templates_select_scoped on public.form_templates
  for select to authenticated using (
    not (select private.member_pin_session_restricted())
    and (
      is_platform_seed
      or organization_id = (select private.current_member_organization())
      -- Preserve a schema already bound to an independently authorized form.
      -- The member_forms lookup runs with the caller's existing RLS/PIN rules.
      or exists (select 1 from public.member_forms f
        where f.template_key = form_templates.key
          and f.template_version = form_templates.version)
    )
  );
comment on policy form_templates_select_scoped on public.form_templates is
  'Tenant isolation (BUG-UG-FORM-TEMPLATES-SHARED-ACROSS-ORGANIZATIONS-20261006): members read the seven platform seeds, their selected organization''s own templates, and only the historical schema of a form they can already read; PIN-restricted sessions read none.';
grant select(organization_id,is_platform_seed) on public.form_templates to authenticated;

-- The historical projection is readable only for already authorized forms;
-- available_to_start prevents that archived schema becoming a new-form choice.
create view public.form_template_registry with (security_invoker = true) as
  select key,version,label_en,label_es,blurb_en,blurb_es,icon,points,active,
    sort,field_schema,created_at,updated_at,organization_id,is_platform_seed,
    (is_platform_seed or organization_id = (select private.current_member_organization()))
      is true as available_to_start
  from public.form_templates;
revoke all on public.form_template_registry from public,anon,authenticated;
grant select on public.form_template_registry to authenticated;

-- Explicit effective definitions captured from all 580 migrations at Main
-- 9d0b68e62721e4f1f20b4c478183b6b842c943bd, preserving installed guards and locks.
CREATE OR REPLACE FUNCTION private.demo_seed_apply_function_parity(p_lane text, p_run_id uuid, p_target_ref text, p_confirm_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '300s'
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

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
  from public.form_templates where active and is_platform_seed order by key, version desc limit 1;
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
end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.form_points(p_template_key text)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce((
    select points from public.form_templates where key = p_template_key and (is_platform_seed or organization_id=(select private.current_member_organization())) order by version desc limit 1
  ), 15);
$function$;

-- The submission award knows the awarded form's pinned version. A form pinned
-- to a quarantined historical template keeps exactly that version's points;
-- every other form keeps the scoped latest-version amount.
CREATE OR REPLACE FUNCTION private.form_points(p_template_key text, p_template_version integer)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce(
    (select points from public.form_templates where key = p_template_key and (is_platform_seed or organization_id=(select private.current_member_organization())) order by version desc limit 1),
    (select points from public.form_templates where key = p_template_key and version = p_template_version),
    15);
$function$;
revoke all on function private.form_points(text, integer) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION private.form_template_label_localized(p_template_key text, p_lang text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce(
    (select case when p_lang = 'es' then label_es else label_en end
     from public.form_templates where key = p_template_key and (is_platform_seed or organization_id=(select private.current_member_organization())) order by version desc limit 1),
    p_template_key);
$function$;

CREATE OR REPLACE FUNCTION public.deactivate_form_template(p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  template_org uuid := (select private.current_member_organization());
  updated integer;
begin
  if caller is null or template_org is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  -- Same per-key lock as upsert: without it, a deactivate racing an upsert can
  -- re-target the OLD max version after EvalPlanQual and silently miss the
  -- just-minted active row.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('form-template-' || p_key, 509));
  update public.form_templates
    set active = false, updated_at = now(), updated_by = caller
    where key = p_key and organization_id = template_org and version = (select max(version) from public.form_templates where key = p_key and organization_id = template_org);
  get diagnostics updated = row_count;
  if updated = 0 then
    -- Changing a shared default creates an organization-local immutable version.
    -- The shared row and every other organization's version remain untouched.
    insert into public.form_templates
      (key,version,label_en,label_es,blurb_en,blurb_es,icon,points,active,sort,field_schema,updated_by,organization_id)
      select t.key,(select max(version)+1 from public.form_templates where key=p_key),
        t.label_en,t.label_es,t.blurb_en,t.blurb_es,t.icon,t.points,'f'::boolean,t.sort,t.field_schema,caller,template_org
      from public.form_templates t where t.key=p_key and t.is_platform_seed;
    get diagnostics updated = row_count;
    if updated = 0 then
      raise exception 'template not found' using errcode = '22023';
    end if;
  end if;
  return pg_catalog.jsonb_build_object('key', p_key, 'active', false);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_admin_reward_economy()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.assert_reward_economy_admin();
  return pg_catalog.jsonb_build_object(
    'rules', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by r.action_kind) from public.member_point_rules r), '[]'::jsonb),
    'tiers', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.tier) from public.member_reward_tiers t), '[]'::jsonb),
    'items', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(i) order by i.sort, i.key) from public.member_reward_items i), '[]'::jsonb),
    'formTemplatePoints', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('key', f.key, 'version', f.version, 'labelEn', f.label_en, 'labelEs', f.label_es, 'points', f.points) order by f.sort, f.key)
      from (select distinct on (key) key, version, label_en, label_es, points, sort from public.form_templates where is_platform_seed or organization_id=(select private.current_member_organization()) order by key, version desc) f
    ), '[]'::jsonb),
    'revisions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by x.created_at desc, x.id desc)
      from (select * from public.member_reward_economy_revisions order by created_at desc, id desc limit 50) x), '[]'::jsonb)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.member_stress_enrich_batch(p_run_id uuid, p_phase text, p_start_ordinal integer, p_batch_count integer, p_target_ref text, p_confirm_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '300s'
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  run private.member_stress_runs%rowtype;
  lo integer := p_start_ordinal;
  hi integer := p_start_ordinal + p_batch_count - 1;
  touched bigint := 0;
  seed text := p_run_id::text;
  pick record;
begin
  perform private.member_stress_authorize(p_target_ref, p_confirm_token);
  if p_batch_count not between 1 and 5000 or p_start_ordinal < 1 then
    raise exception 'invalid enrichment batch range';
  end if;
  select * into run from private.member_stress_runs where id = p_run_id;
  if not found then raise exception 'unknown member stress run'; end if;
  -- 'applied' or 'verified' only: enrichment must never race the seeder, and a
  -- removed/removing run has nothing to enrich.
  if run.state not in ('applied', 'verified') then
    raise exception 'run must be applied or verified to enrich (state %)', run.state;
  end if;

  if p_phase = 'profile' then
    with tgt as (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    assigned as (
      select t.*,
        (select cp.chapter_id from private.member_stress_chapter_plan cp
          where private.member_stress_pick(t.s || ':chapter', 100000) between cp.lo and cp.hi
          limit 1) as chapter_id
      from tgt t
    ),
    named as (
      select a.*,
        (select v.value from private.member_stress_name_pool v
          where v.part = 'first'
            and v.idx = private.member_stress_pick(a.s || ':first',
              (select pg_catalog.count(*)::integer from private.member_stress_name_pool where part = 'first'))) as fn,
        (select v.value from private.member_stress_name_pool v
          where v.part = 'last'
            and v.idx = private.member_stress_pick(a.s || ':last',
              (select pg_catalog.count(*)::integer from private.member_stress_name_pool where part = 'last'))) as ln
      from assigned a
    ),
    resolved as (
      select n.*, c.region as agency,
        (select r.title from private.member_stress_role_pool r
          where r.agency = c.region
            and r.idx = private.member_stress_pick(n.s || ':role',
              (select pg_catalog.count(*)::integer from private.member_stress_role_pool r2 where r2.agency = c.region))) as role_title
      from named n join public.chapters c on c.id = n.chapter_id
    ),
    upd as (
      update public.member_profiles mp
      set chapter_id = r.chapter_id,
          first_name = r.fn,
          full_name = r.fn || ' ' || r.ln,
          initials = pg_catalog.upper(pg_catalog.left(r.fn, 1) || pg_catalog.left(r.ln, 1)),
          role_line = r.role_title,
          member_since = 1998 + private.member_stress_pick(r.s || ':since', 28),
          language = case when private.member_stress_rand(r.s || ':lang') < 0.15 then 'es' else 'en' end
      from resolved r
      where mp.id = r.user_id
      returning 1
    )
    select pg_catalog.count(*) into touched from upd;

  elsif p_phase = 'texture' then
    -- Notification/conversation/message variety. `kind` is NEVER touched: see
    -- the outbound-delivery rule in this file's header.
    with tgt as (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    ranked as (
      select n.id, t.s,
        pg_catalog.row_number() over (partition by n.user_id order by n.created_at) as rn
      from public.member_notifications n join tgt t on t.user_id = n.user_id
    ),
    upd as (
      update public.member_notifications n
      set title = (array[
            'Step 2 hearing scheduled','Contract action update','Chapter meeting reminder',
            'Your grievance moved forward','New rights lesson available','Steward office hours',
            'Membership drive this week','Workload survey closing'
          ])[1 + private.member_stress_pick(k.s || ':ntitle' || k.rn, 8)],
          body = (array[
            'Your steward will meet you 30 minutes before the hearing.',
            'The bargaining team posted a summary of this week''s session.',
            'Agenda and the call-in link are posted on the chapter board.',
            'The employer''s written answer is due at the end of next week.',
            'A three-minute refresher on your representation rights.',
            'Drop-in hours run Thursday afternoon at the area office.',
            'Two co-workers signed up this week — say hello.',
            'Last call to log your caseload for the quarter.'
          ])[1 + private.member_stress_pick(k.s || ':nbody' || k.rn, 8)],
          created_at = pg_catalog.now()
            - (private.member_stress_pick(k.s || ':nage' || k.rn, 120) || ' days')::interval
            - (private.member_stress_pick(k.s || ':nhr' || k.rn, 24) || ' hours')::interval,
          read_at = case when private.member_stress_rand(k.s || ':nread' || k.rn) < 0.62
            then pg_catalog.now() - (private.member_stress_pick(k.s || ':nrd' || k.rn, 96) || ' hours')::interval
            else null end
      from ranked k
      where n.id = k.id
      returning 1
    )
    select pg_catalog.count(*) into touched from upd;

    with tgt as (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    ranked as (
      select c.id, t.s,
        pg_catalog.row_number() over (partition by c.user_id order by c.created_at) as rn
      from public.member_conversations c join tgt t on t.user_id = c.user_id
    )
    update public.member_conversations c
    set title = (array[
          'Chapter steward','Area steward','Grievance chair','Field representative','Chapter president'
        ])[1 + private.member_stress_pick(k.s || ':ctitle' || k.rn, 5)],
        initials = (array['CS','AS','GC','FR','CP'])[1 + private.member_stress_pick(k.s || ':ctitle' || k.rn, 5)],
        created_at = pg_catalog.now() - (30 + private.member_stress_pick(k.s || ':cage' || k.rn, 300) || ' days')::interval,
        updated_at = pg_catalog.now() - (private.member_stress_pick(k.s || ':cupd' || k.rn, 30) || ' days')::interval
    from ranked k
    where c.id = k.id;

    with tgt as (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    ranked as (
      select m.id, t.s,
        pg_catalog.row_number() over (partition by m.user_id order by m.created_at) as rn
      from public.member_messages m join tgt t on t.user_id = m.user_id
    )
    update public.member_messages m
    set body = (array[
          'Now the employer owes a written Step 2 answer, due at the end of next week.',
          'I filed the grievance this morning — you are copied on the paperwork.',
          'Bring your notes from the meeting and we will go through them together.',
          'They agreed to restore the schedule. I will confirm in writing.',
          'You have the right to a union rep in that meeting. Do not go alone.',
          'The caseload numbers you sent are going into the standards push.'
        ])[1 + private.member_stress_pick(k.s || ':mbody' || k.rn, 6)],
        created_at = pg_catalog.now() - (private.member_stress_pick(k.s || ':mage' || k.rn, 240) || ' days')::interval
    from ranked k
    where m.id = k.id;

  elsif p_phase = 'cases' then
    -- The clone tell this whole migration exists to kill: every member carried
    -- the same four references. Rewrite to a globally unique
    -- GR-<year>-<ordinal><slot> and vary count, type, step and status.
    with tgt as (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    ranked as (
      select c.id, t.s, t.ordinal,
        pg_catalog.row_number() over (partition by c.user_id order by c.created_at desc) as rn
      from public.member_cases c join tgt t on t.user_id = c.user_id
    ),
    doomed as (
      -- Keep 0-4 cases per member (mean ~2.2): a fixed four-per-member is as
      -- artificial as identical references.
      delete from public.member_cases c
      using ranked k
      where c.id = k.id
        and k.rn > private.member_stress_pick(k.s || ':ncases', 5)
      returning 1
    )
    select pg_catalog.count(*) into touched from doomed;

    with tgt as (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    ranked as (
      select c.id, t.s, t.ordinal,
        pg_catalog.row_number() over (partition by c.user_id order by c.created_at desc) as rn
      from public.member_cases c join tgt t on t.user_id = c.user_id
    ),
    shaped as (
      select k.*,
        private.member_stress_pick(k.s || ':ctype' || k.rn, 6) as type_idx,
        private.member_stress_pick(k.s || ':cage' || k.rn, 900) as age_days
      from ranked k
    )
    update public.member_cases c
    set reference = 'GR-' || pg_catalog.to_char(pg_catalog.now() - (s.age_days || ' days')::interval, 'YYYY')
          || '-' || pg_catalog.lpad(((s.ordinal - 1) * 4 + s.rn)::text, 7, '0'),
        case_type = (array['Discipline','Telework','Safety','Scheduling','Caseload','Contract'])[1 + s.type_idx],
        title = (array[
          'Step 2 — discipline','Telework schedule restored','Safety equipment issued',
          'Scheduling shift corrected','Caseload above the standard','Contract language dispute'
        ])[1 + s.type_idx],
        articles = (array[
          'Article 12 — Discipline · Article 3 — Union Rights and Representation',
          'Article 7 — Hours of Work',
          'Article 16 — Health and Safety',
          'Article 7 — Hours of Work',
          'Article 24 — Workload',
          'Article 5 — Management Rights'
        ])[1 + s.type_idx],
        step = case when s.age_days < 120 then (array['Step 1','Step 2','Step 3'])[1 + private.member_stress_pick(s.s || ':cstep' || s.rn, 3)] else 'Closed' end,
        status = case when s.age_days < 120 then 'active' else 'resolved' end,
        deadline = (pg_catalog.now() - (s.age_days || ' days')::interval + interval '30 days')::date,
        created_at = pg_catalog.now() - (s.age_days || ' days')::interval,
        updated_at = pg_catalog.now() - (s.age_days / 2 || ' days')::interval
    from shaped s
    where c.id = s.id;

    -- Case timelines: 0-3 updates on each surviving case.
    insert into public.member_case_updates (case_id, user_id, body, created_at)
    select c.id, c.user_id,
      (array[
        'Filed with the area office and logged by the steward.',
        'Step 1 meeting held; the employer asked for a week to respond.',
        'Written answer received — escalating to the next step.',
        'Resolved. The member confirmed the correction took effect.'
      ])[1 + private.member_stress_pick(t.s || ':cu' || c.id::text || g.i::text, 4)],
      c.created_at + (g.i * (7 + private.member_stress_pick(t.s || ':cud' || c.id::text || g.i::text, 20)) || ' days')::interval
    from private.member_stress_ledger l
    join public.member_cases c on c.user_id = l.user_id
    cross join lateral (select seed || ':' || l.ordinal::text as s) t
    cross join lateral generate_series(1, private.member_stress_pick(t.s || ':nupd' || c.id::text, 4)) g(i)
    where l.run_id = p_run_id and l.ordinal between lo and hi
    on conflict do nothing;

  elsif p_phase = 'rights' then
    -- 1-5 of the five live lessons, at varying completion depth. The
    -- completed_steps CHECK (cardinality <= 64, migration 20260725160000) is
    -- nowhere near binding at three steps.
    -- A CASE, not a subscripted nested array: `(array[array[0], array[0,1]])[n]`
    -- reads as a single-element access on a 2-D array and yields integer, not
    -- integer[], which the column rejects.
    insert into public.member_rights_progress (lesson_id, user_id, completed_steps)
    select les.id, l.user_id,
      case private.member_stress_pick(seed || ':' || l.ordinal::text || ':rp' || les.id, 3)
        when 0 then array[0]
        when 1 then array[0, 1]
        else array[0, 1, 2]
      end
    from private.member_stress_ledger l
    cross join public.member_rights_lessons les
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':rl' || les.id) < 0.42
    on conflict (lesson_id, user_id) do nothing;
    get diagnostics touched = row_count;

  elsif p_phase = 'participation' then
    -- RSVPs across all events; check-ins only against events that have already
    -- happened, and only for members who RSVP'd.
    -- status is constrained to ('going','not_going') — there is no 'maybe'.
    insert into public.member_event_rsvps (event_id, user_id, status, created_at, updated_at)
    select e.id, l.user_id,
      case when private.member_stress_rand(seed || ':' || l.ordinal::text || ':rs' || e.id) < 0.82 then 'going' else 'not_going' end,
      e.starts_at - interval '14 days', e.starts_at - interval '14 days'
    from private.member_stress_ledger l
    cross join public.member_events e
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':rv' || e.id) < 0.26
    on conflict (event_id, user_id) do nothing;
    get diagnostics touched = row_count;

    insert into public.member_event_checkins (event_id, user_id, checked_in_at, scanned_by)
    select r.event_id, r.user_id, e.starts_at + interval '12 minutes', null
    from public.member_event_rsvps r
    join public.member_events e on e.id = r.event_id
    join private.member_stress_ledger l on l.user_id = r.user_id
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and e.starts_at < pg_catalog.now()
      and r.status = 'going'
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':ci' || r.event_id) < 0.61
    on conflict (event_id, user_id) do nothing;

    -- Surveys: the two closed pulses take broad participation, the live one less.
    insert into public.member_survey_responses (survey_id, option_id, user_id, submitted_at)
    select o.survey_id, o.id, l.user_id,
      coalesce(s.closes_at, pg_catalog.now()) - (1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':sd' || o.survey_id, 20) || ' days')::interval
    from private.member_stress_ledger l
    cross join public.member_surveys s
    join public.member_survey_options o on o.survey_id = s.id
      and o.order_index = 1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':so' || s.id,
        (select pg_catalog.count(*)::integer from public.member_survey_options o2 where o2.survey_id = s.id))
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':sv' || s.id) < case when s.active then 0.19 else 0.34 end
    on conflict (survey_id, user_id) do nothing;

    insert into public.member_broadcast_receipts (broadcast_id, user_id, read_at)
    select b.id, l.user_id,
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':br' || b.id, 200) || ' days')::interval
    from private.member_stress_ledger l
    cross join public.member_broadcasts b
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':bc' || b.id) < 0.34
    on conflict (broadcast_id, user_id) do nothing;

    -- Steward requests are INSERTED in their FINAL status. An UPDATE here would
    -- fire member_steward_requests_award_on_ack (20260725230000) and mint the
    -- steward award at now() for every row — see this file's header.
    insert into public.member_steward_requests (user_id, lesson_id, status, created_at, acknowledged_at, closed_at, handled_by)
    select l.user_id,
      (select les.id from public.member_rights_lessons les
        order by les.id
        offset private.member_stress_pick(seed || ':' || l.ordinal::text || ':srl', 5) limit 1),
      (array['acknowledged','closed','closed','requested'])[1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':srs', 4)],
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':srd', 400) || ' days')::interval,
      case when private.member_stress_pick(seed || ':' || l.ordinal::text || ':srs', 4) < 3
        then pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':sra', 380) || ' days')::interval end,
      case when private.member_stress_pick(seed || ':' || l.ordinal::text || ':srs', 4) between 1 and 2
        then pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':src', 360) || ' days')::interval end,
      null
    from private.member_stress_ledger l
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':sr') < 0.11
    on conflict do nothing;

    insert into public.member_forms (user_id, template_key, template_version, status, answers, step, submitted_at, created_at, updated_at)
    select l.user_id, ft.key, ft.version,
      (array['submitted','approved','approved','draft'])[1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':fs', 4)],
      '{}'::jsonb, 0,
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':fd', 300) || ' days')::interval,
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':fd', 300) || ' days')::interval,
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':fu', 200) || ' days')::interval
    from private.member_stress_ledger l
    join lateral (
      select f.key, f.version from public.form_templates f where f.active and f.is_platform_seed
      order by f.key
      offset private.member_stress_pick(seed || ':' || l.ordinal::text || ':ft',
        (select pg_catalog.count(*)::integer from public.form_templates where active and is_platform_seed))
      limit 1
    ) ft on true
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':fm') < 0.15
    on conflict do nothing;

    -- Three constraints govern this table and all three are easy to trip:
    -- receipt_code must match '^[0-9a-f]{8}$' (lower-case, exactly 8), every
    -- count column is bounded 0..300, and pt_hours_when_part_time requires a
    -- non-null pt_hours whenever employment is 'part_time'.
    insert into public.member_workload_logs (user_id, priority, pending, unread_docs, todos, referrals,
      ce_activities, assistance_requests, aged_cases, weekly_assigned, employment, pt_hours, receipt_code,
      created_at, logged_on)
    select l.user_id,
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wp', 12),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wpe', 40),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wu', 25),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wt', 30),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wr', 15),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wc', 8),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wa', 10),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wg', 18),
      10 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':ww', 25),
      case when private.member_stress_rand(seed || ':' || l.ordinal::text || ':we') < 0.86 then 'full_time' else 'part_time' end,
      case when private.member_stress_rand(seed || ':' || l.ordinal::text || ':we') < 0.86 then null
        else (16 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':wph', 24))::smallint end,
      pg_catalog.substr(pg_catalog.md5(seed || ':wrc:' || l.ordinal::text), 1, 8),
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':wd', 120) || ' days')::interval,
      (pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':wd', 120) || ' days')::interval)::date
    from private.member_stress_ledger l
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':wl') < 0.23
    on conflict do nothing;

    with threads as (
      insert into public.member_guide_threads (user_id, title, created_at, updated_at)
      select l.user_id,
        (array[
          'What are my Weingarten rights?','How do I file a grievance?',
          'Can they change my schedule without notice?','What counts as a safety refusal?',
          'How much notice for a shift change?'
        ])[1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':gt', 5)],
        pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':gd', 180) || ' days')::interval,
        pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':gd', 180) || ' days')::interval
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
        and private.member_stress_rand(seed || ':' || l.ordinal::text || ':gv') < 0.09
      returning id, user_id, title, created_at
    )
    insert into public.member_guide_messages (thread_id, user_id, role, body, created_at)
    select t.id, t.user_id, m.role, m.body, t.created_at + m.offs
    from threads t
    cross join lateral (values
      ('user', t.title, interval '0 minutes'),
      ('assistant', 'Here is what your contract and the law say, with the article citations.', interval '9 seconds')
    ) as m(role, body, offs);

  elsif p_phase = 'ballots' then
    -- Turnout on each ballot, weighted lower on the still-open one. Votes are
    -- stored unlinkably since 20260808230000: participation lives in
    -- member_ballot_receipts and the choice sits in member_ballot_choices with
    -- no voter column, so enrichment issues a receipt per synthetic voter and
    -- files the matching anonymous choice only when that receipt is new
    -- (re-runs and the two real votes on ballot-2026 both surface as an
    -- existing receipt and are skipped). Choices carry stress_run_id so
    -- removal can sweep what the auth.users cascade cannot reach.
    for pick in
      select b.id as ballot_id, o.id as option_id, l.user_id
      from private.member_stress_ledger l
      cross join public.member_ballots b
      join public.member_ballot_options o on o.ballot_id = b.id
        and o.order_index = 1 + case
          when private.member_stress_rand(seed || ':' || l.ordinal::text || ':bo' || b.id) < 0.74 then 0
          when private.member_stress_rand(seed || ':' || l.ordinal::text || ':bo' || b.id) < 0.93 then 1
          else 2 end
      where l.run_id = p_run_id and l.ordinal between lo and hi
        and private.member_stress_rand(seed || ':' || l.ordinal::text || ':bv' || b.id) < case when b.active then 0.31 else 0.38 end
    loop
      if private.issue_ballot_receipt(pick.ballot_id, pick.user_id) is not null then
        insert into public.member_ballot_choices (ballot_id, option_id, stress_run_id)
        values (pick.ballot_id, pick.option_id, p_run_id);
        touched := touched + 1;
      end if;
    end loop;

  elsif p_phase = 'points' then
    -- Direct, BACKDATED inserts. Routing these through member_action_log would
    -- hand them to private.award_member_points, which stamps occurred_at =
    -- now() and enforces per-kind weekly caps — collapsing 100k members'
    -- histories into the current week and paying almost none of them.
    insert into public.member_point_events (user_id, action_key, action_kind, points, occurred_at)
    select l.user_id,
      'hist-' || l.ordinal::text || '-' || g.i::text,
      (array['vote','survey','rights','case','rsvp','checkin','form','message'])[1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':pk' || g.i::text, 8)],
      (array[20, 10, 15, 25, 40, 50, 15, 2])[1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':pk' || g.i::text, 8)],
      pg_catalog.now() - (7 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':pd' || g.i::text, 540) || ' days')::interval
    from private.member_stress_ledger l
    cross join lateral generate_series(1, private.member_stress_pick(seed || ':' || l.ordinal::text || ':pn', 11)) g(i)
    where l.run_id = p_run_id and l.ordinal between lo and hi
    on conflict (user_id, action_key) do nothing;
    get diagnostics touched = row_count;

  elsif p_phase = 'roles' then
    -- Chapter-scoped stewards, roughly 1 per 90 members, so the steward desk
    -- and get_steward_chapter_member_count have realistic scoped populations.
    insert into public.member_roles (user_id, role, chapter_id, granted_at, granted_by)
    select l.user_id, 'steward', mp.chapter_id,
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':rg', 700) || ' days')::interval,
      null
    from private.member_stress_ledger l
    join public.member_profiles mp on mp.id = l.user_id
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':stw') < 0.011
    on conflict (user_id, role) do nothing;
    get diagnostics touched = row_count;

  else
    raise exception 'unknown enrichment phase %', p_phase;
  end if;

  return jsonb_build_object('phase', p_phase, 'from', lo, 'to', hi, 'touched', touched);
end;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.presg_demo_enrich_batch(p_run_id uuid, p_phase text, p_start_ordinal integer, p_batch_count integer, p_target_ref text, p_confirm_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '300s'
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  run private.presg_demo_runs%rowtype;
  lo integer := p_start_ordinal;
  hi integer := p_start_ordinal + p_batch_count - 1;
  touched bigint := 0;
  seed text := p_run_id::text;
  t0 timestamptz := pg_catalog.now() - interval '1460 days';
begin
  perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  if p_batch_count not between 1 and 2000 or p_start_ordinal < 1 then
    raise exception 'invalid enrichment batch range';
  end if;
  select * into run from private.presg_demo_runs where id = p_run_id;
  if not found then raise exception 'unknown presg demo run'; end if;
  if run.state not in ('applied', 'verified') then
    raise exception 'run must be applied to enrich (state %)', run.state;
  end if;

  if p_phase = 'roles' then
    -- The organizing committee: chapter-scoped steward equivalents. The lead
    -- also carries coordinator+admin and the second seat carries advisor so
    -- every staff surface has at least one working demo identity.
    insert into public.member_roles (user_id, role, chapter_id, granted_at, granted_by)
    select l.user_id, 'steward', 'presg',
      private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) + interval '30 days', null
    from private.presg_demo_ledger l
    where l.run_id = p_run_id and l.ordinal between lo and hi and l.committee
    on conflict (user_id, role) do nothing;
    get diagnostics touched = row_count;

    insert into public.member_roles (user_id, role, chapter_id, granted_at, granted_by)
    select l.user_id, extra.role, 'presg', t0 + interval '120 days', null
    from private.presg_demo_ledger l
    join (values (1, 'coordinator'), (1, 'admin'), (2, 'advisor')) extra(ordinal, role)
      on extra.ordinal = l.ordinal
    where l.run_id = p_run_id and l.ordinal between lo and hi
    on conflict (user_id, role) do nothing;

    insert into public.member_role_chapters (user_id, role, chapter_id, granted_at, granted_by)
    select r.user_id, r.role, 'presg', r.granted_at, r.granted_by
    from public.member_roles r
    join private.presg_demo_ledger l on l.user_id = r.user_id and l.run_id = p_run_id
    where l.ordinal between lo and hi
    on conflict (user_id, role, chapter_id) do nothing;

    insert into public.organization_role_grants (organization_id, user_id, role, granted_at, granted_by)
    select private.member_stress_uuid(p_run_id::text || ':presg:organization'), r.user_id, r.role,
      r.granted_at, r.granted_by
    from public.member_roles r
    join private.presg_demo_ledger l on l.user_id = r.user_id and l.run_id = p_run_id
    where l.ordinal between lo and hi
    on conflict (organization_id, user_id, role) do nothing;

  elsif p_phase = 'texture' then
    -- Conversations with the committee plus the notification feed. Seeded
    -- notifications stay kind 'general' — the outbound rule at the top of
    -- this file — and read like the campaign.
    with tgt as (
      select l.ordinal, l.user_id, l.committee, seed || ':' || l.ordinal::text as s,
        private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) as joined
      from private.presg_demo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    convs as (
      select t.*, slot.n as slot, slot.title, slot.initials,
        private.member_stress_uuid(t.s || ':presg:conv:' || slot.n::text) as conv_id,
        4 + (case when t.committee then 24 else 0 end)
          + private.member_stress_pick(t.s || ':presg:msgs:' || slot.n::text,
              case when t.committee then 60 else 16 end) as msg_count
      from tgt t
      cross join (values
        (1, 'Organizing committee', 'OC'),
        (2, 'Committee captains', 'CC'),
        (3, 'Membership questions', 'MQ')
      ) slot(n, title, initials)
      where slot.n = 1
        or (slot.n = 2 and t.committee)
        or (slot.n = 3 and not t.committee
            and private.member_stress_rand(t.s || ':presg:conv3') < 0.35)
    ),
    conv_ins as (
      insert into public.member_conversations (id, user_id, title, initials, created_at, updated_at)
      select c.conv_id, c.user_id, c.title, c.initials,
        c.joined + interval '2 days',
        c.joined + interval '2 days'
          + (((c.msg_count - 1)::double precision / c.msg_count)
             * extract(epoch from (pg_catalog.now() - interval '1 day' - (c.joined + interval '2 days'))) || ' seconds')::interval
      from convs c
      on conflict (id) do nothing
      returning 1
    )
    select pg_catalog.count(*) into touched from conv_ins;

    with tgt as (
      select l.ordinal, l.user_id, l.committee, seed || ':' || l.ordinal::text as s,
        private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) as joined
      from private.presg_demo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    convs as (
      select t.*, slot.n as slot,
        private.member_stress_uuid(t.s || ':presg:conv:' || slot.n::text) as conv_id,
        4 + (case when t.committee then 24 else 0 end)
          + private.member_stress_pick(t.s || ':presg:msgs:' || slot.n::text,
              case when t.committee then 60 else 16 end) as msg_count
      from tgt t
      cross join (values (1), (2), (3)) slot(n)
      where slot.n = 1
        or (slot.n = 2 and t.committee)
        or (slot.n = 3 and not t.committee
            and private.member_stress_rand(t.s || ':presg:conv3') < 0.35)
    ),
    msgs as (
      select c.*, m.i,
        c.joined + interval '2 days'
          + (((m.i - 1)::double precision / c.msg_count)
             * extract(epoch from (pg_catalog.now() - interval '1 day' - (c.joined + interval '2 days'))) || ' seconds')::interval
          as msg_at,
        private.member_stress_rand(c.s || ':presg:mwho:' || c.slot::text || ':' || m.i::text) < 0.48 as from_member
      from convs c
      cross join lateral generate_series(1, c.msg_count) m(i)
    )
    insert into public.member_messages (id, conversation_id, user_id, sender_kind, sender_name, body, read_at, created_at)
    select
      private.member_stress_uuid(m.s || ':presg:msg:' || m.slot::text || ':' || m.i::text),
      m.conv_id, m.user_id,
      case when m.from_member then 'member' else 'steward' end,
      case when m.from_member
        then private.presg_demo_full_name(p_run_id, m.ordinal)
        else private.presg_demo_full_name(p_run_id,
          1 + private.member_stress_pick(m.s || ':presg:mstw:' || m.slot::text || ':' || m.i::text, run.committee_count))
      end,
      (array[
        'Thanks for signing on — want to grab five minutes before your shift this week?',
        'Quick check-in: how did the conversation with your coworker go?',
        'The committee meets Thursday at 6. Can you make it?',
        'I logged the schedule story you told me. It is going in the tracker.',
        'What questions do you have before the all-staff meeting?',
        'Two people on your team asked about card signing — can you introduce me?',
        'Reminder that this stays between us until we go public.',
        'That meeting they pulled you into: you had the right to stay silent about the campaign.',
        'We hit the next card milestone. Do not post it publicly yet.',
        'Can you take a turnout list for Thursday? Ten names, all your floor.',
        'The petition text is ready for feedback in the channel.',
        'Welcome! A captain covers your program — expect a hello this week.',
        'I can talk after 7 most nights, whatever works for you.',
        'Yes — count me in for the weekend visits.',
        'I was nervous about the button but three of us wore it together.',
        'Management asked me about the union today. I said we can talk on my break.',
        'My coworker wants to sign. What is the next step?',
        'Got it, I will bring the stories to the meeting.',
        'The night shift feels left out — can someone come by at 11?',
        'Thanks for checking in. This week was rough but we are still in.',
        'I read the rights lesson — the captive-audience part was new to me.',
        'Adding two names to the turnout list now.',
        'Done. Both conversations went better than expected.',
        'See you Thursday.'
      ])[1 + private.member_stress_pick(m.s || ':presg:mbody:' || m.slot::text || ':' || m.i::text, 24)],
      case when m.i >= m.msg_count - 1 and not m.from_member
             and private.member_stress_rand(m.s || ':presg:mrd:' || m.slot::text || ':' || m.i::text) < 0.55
        then null
        else m.msg_at + interval '9 hours' end,
      m.msg_at
    from msgs m
    on conflict (id) do nothing;

    with tgt as (
      select l.ordinal, l.user_id, l.committee, seed || ':' || l.ordinal::text as s
      from private.presg_demo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    feed as (
      select t.*, n.i,
        pg_catalog.now()
          - ((pg_catalog.floor(pg_catalog.power(private.member_stress_rand(t.s || ':presg:nage:' || n.i::text), 2) * 150) + 1) || ' days')::interval
          - ((private.member_stress_pick(t.s || ':presg:nhr:' || n.i::text, 22) + 1) || ' hours')::interval as at
      from tgt t
      cross join lateral generate_series(1,
        case when t.committee then 24 + private.member_stress_pick(t.s || ':presg:nn', 26)
             else 4 + private.member_stress_pick(t.s || ':presg:nn', 14) end) n(i)
    )
    insert into public.member_notifications (id, user_id, title, body, kind, read_at, created_at)
    select
      private.member_stress_uuid(f.s || ':presg:ntf:' || f.i::text),
      f.user_id,
      (array[
        'New reply in your chapter thread',
        'Card count milestone reached',
        'Committee meeting tomorrow',
        'Your issue report was received',
        'All-staff meeting RSVP is open',
        'New rights lesson: captive-audience meetings',
        'Petition draft ready for review',
        'House-visit debrief posted',
        'Election readiness checklist updated',
        'Thanks for talking with your coworkers'
      ])[1 + private.member_stress_pick(f.s || ':presg:nti:' || f.i::text, 10)],
      (array[
        'A committee member replied to the thread you follow.',
        'Another floor crossed majority support this week.',
        'Agenda and location are posted in the Actions channel.',
        'A committee member picked it up and will follow through with you.',
        'Reserve your spot so we can plan the room and childcare.',
        'Three minutes on what management can and cannot do in mandatory meetings.',
        'Read the draft and leave one comment before Friday.',
        'Weekend numbers and the next route list are in the channel.',
        'Two items left before the filing window opens.',
        'Every one-on-one moves the campaign. Log it when you can.'
      ])[1 + private.member_stress_pick(f.s || ':presg:nbo:' || f.i::text, 10)],
      'general',
      case when private.member_stress_rand(f.s || ':presg:nrd:' || f.i::text) < 0.62
        then f.at + ((1 + private.member_stress_pick(f.s || ':presg:nrh:' || f.i::text, 60)) || ' hours')::interval
        else null end,
      f.at
    from feed f
    on conflict (id) do nothing;

  elsif p_phase = 'casework' then
    -- Workplace issues tracked with the committee. Pre-union: the legal
    -- grounding is the NLRA, not contract articles, and the assigned
    -- "steward" is a committee member.
    with tgt as (
      select l.ordinal, l.user_id, l.committee, seed || ':' || l.ordinal::text as s,
        private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) as joined
      from private.presg_demo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    cased as (
      select t.*, c.slot,
        private.member_stress_uuid(t.s || ':presg:case:' || c.slot::text) as case_id,
        private.member_stress_pick(t.s || ':presg:ctype:' || c.slot::text, 6) as type_idx,
        t.joined + interval '20 days'
          + ((private.member_stress_pick(t.s || ':presg:cage:' || c.slot::text,
              greatest((extract(epoch from (pg_catalog.now() - t.joined)) / 86400)::integer - 30, 1))) || ' days')::interval as opened,
        1 + private.member_stress_pick(t.s || ':presg:cstw:' || c.slot::text, run.committee_count) as steward_ordinal
      from tgt t
      cross join (values (1), (2)) c(slot)
      where (c.slot = 1 and private.member_stress_rand(t.s || ':presg:hascase')
              < case when t.committee then 0.55 else 0.30 end)
         or (c.slot = 2 and private.member_stress_rand(t.s || ':presg:hascase2') < 0.08)
    ),
    case_ins as (
      insert into public.member_cases (id, user_id, reference, title, deadline, case_type, articles, step,
        status, steward_user_id, steward_name, assigned_at, created_at, updated_at,
        deadline_notice_7_sent_at, deadline_notice_3_sent_at, deadline_notice_1_sent_at)
      select
        c.case_id, c.user_id,
        'PSG-' || pg_catalog.to_char(c.opened, 'YYYY') || '-' || pg_catalog.lpad((c.ordinal * 2 - 2 + c.slot)::text, 5, '0'),
        (array[
          'Schedule changed without notice',
          'Unsafe overnight staffing',
          'Chronic short-staffing on the unit',
          'Missing overtime pay',
          'Written up after speaking up',
          'Hours cut after wearing a button'
        ])[1 + c.type_idx],
        case when c.opened > pg_catalog.now() - interval '75 days'
          then (pg_catalog.now() + ((5 + private.member_stress_pick(c.s || ':presg:cdl:' || c.slot::text, 40)) || ' days')::interval)::date
          else (c.opened + interval '45 days')::date end,
        (array['Scheduling', 'Safety', 'Staffing', 'Pay accuracy', 'Discipline', 'Retaliation'])[1 + c.type_idx],
        (array[
          'NLRA §7 — protected concerted activity',
          'OSHA general duty · NLRA §7',
          'NLRA §7 — protected concerted activity',
          'FLSA wage claim · NLRA §7',
          'NLRA §8(a)(1) — interference',
          'NLRA §8(a)(3) — retaliation'
        ])[1 + c.type_idx],
        case when c.opened > pg_catalog.now() - interval '75 days'
          then (array['Documenting', 'Raised with management', 'Group action planned'])
            [1 + private.member_stress_pick(c.s || ':presg:cstep:' || c.slot::text, 3)]
          else 'Closed' end,
        case when c.opened > pg_catalog.now() - interval '75 days' then 'active' else 'resolved' end,
        private.presg_demo_user_id(p_run_id, c.steward_ordinal),
        private.presg_demo_full_name(p_run_id, c.steward_ordinal),
        c.opened + interval '2 days',
        c.opened,
        c.opened + interval '9 days',
        case when c.opened > pg_catalog.now() - interval '75 days' then null else c.opened + interval '38 days' end,
        case when c.opened > pg_catalog.now() - interval '75 days' then null else c.opened + interval '42 days' end,
        case when c.opened > pg_catalog.now() - interval '75 days' then null else c.opened + interval '44 days' end
      from cased c
      on conflict (id) do nothing
      returning 1
    )
    select pg_catalog.count(*) into touched from case_ins;

    insert into public.member_case_updates (id, case_id, user_id, body, created_at)
    select
      private.member_stress_uuid(l.user_id::text || ':presg:cu:' || c.id::text || ':' || g.i::text),
      c.id, c.user_id,
      (array[
        'Logged the incident with dates, shifts and witnesses.',
        'Committee raised it in the group meeting with the program director.',
        'Management promised a written answer by Friday. Clock started.',
        'Added to the petition evidence pack with the member''s consent.',
        'Fixed — schedule restored. Keeping the documentation anyway.',
        'Escalating: three coworkers reported the same thing this month.'
      ])[1 + private.member_stress_pick(seed || ':presg:cub:' || c.id::text || ':' || g.i::text, 6)],
      c.created_at + ((g.i * (5 + private.member_stress_pick(seed || ':presg:cud:' || c.id::text || ':' || g.i::text, 12))) || ' days')::interval
    from private.presg_demo_ledger l
    join public.member_cases c on c.user_id = l.user_id
    cross join lateral generate_series(1, 1 + private.member_stress_pick(seed || ':presg:cun:' || c.id::text, 3)) g(i)
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and c.reference like 'PSG-%'
    on conflict (id) do nothing;

    -- Help requests to the committee, inserted in FINAL status (the
    -- award-on-acknowledgment trigger is UPDATE-only and must stay silent).
    insert into public.member_steward_requests (id, user_id, lesson_id, status, created_at, acknowledged_at, closed_at, handled_by)
    select
      private.member_stress_uuid(t.s || ':presg:sreq'),
      t.user_id,
      case when private.member_stress_rand(t.s || ':presg:srl') < 0.5 then null
        else (select les.id from public.member_rights_lessons les
          order by les.id
          offset private.member_stress_pick(t.s || ':presg:srlx',
            greatest((select pg_catalog.count(*)::integer from public.member_rights_lessons), 1))
          limit 1) end,
      case when private.member_stress_rand(t.s || ':presg:srs') < 0.12 then 'requested'
           when private.member_stress_rand(t.s || ':presg:srs') < 0.56 then 'acknowledged'
           else 'closed' end,
      case when private.member_stress_rand(t.s || ':presg:srs') < 0.12
        then pg_catalog.now() - ((1 + private.member_stress_pick(t.s || ':presg:srd', 9)) || ' days')::interval
        else t.joined + interval '15 days'
          + ((private.member_stress_pick(t.s || ':presg:srd',
              greatest((extract(epoch from (pg_catalog.now() - t.joined)) / 86400)::integer - 20, 1))) || ' days')::interval
      end,
      case when private.member_stress_rand(t.s || ':presg:srs') >= 0.12
        then t.joined + interval '16 days' end,
      case when private.member_stress_rand(t.s || ':presg:srs') >= 0.56
        then t.joined + interval '19 days' end,
      private.presg_demo_user_id(p_run_id, 1 + private.member_stress_pick(t.s || ':presg:srh', run.committee_count))
    from (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s,
        private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) as joined
      from private.presg_demo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi and not l.committee
    ) t
    where private.member_stress_rand(t.s || ':presg:hasreq') < 0.45
    on conflict (id) do nothing;

    perform private.presg_demo_sweep_trigger_rows(p_run_id);

  elsif p_phase = 'participation' then
    -- Participation rises across the campaign: the engagement probability is
    -- scaled by how far into the four years each event or vote sits, and
    -- nobody participates in anything dated before they signed on.
    insert into public.member_event_rsvps (event_id, user_id, status, created_at, updated_at)
    select e.id, l.user_id,
      case when private.member_stress_rand(seed || ':' || l.ordinal::text || ':presg:rs:' || e.id) < 0.9
        then 'going' else 'not_going' end,
      e.starts_at - ((2 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':presg:rt:' || e.id, 10)) || ' days')::interval,
      e.starts_at - ((2 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':presg:rt:' || e.id, 10)) || ' days')::interval
    from private.presg_demo_ledger l
    cross join public.member_events e
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and e.chapter_id = 'presg'
      and private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) < e.starts_at - interval '3 days'
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':presg:rv:' || e.id)
        < case when l.committee then 0.92
            else 0.05 + 0.32 * least(extract(epoch from (e.starts_at - (pg_catalog.now() - interval '1460 days')))
              / extract(epoch from interval '1460 days'), 1.0) end
    on conflict (event_id, user_id) do nothing;
    get diagnostics touched = row_count;

    insert into public.member_event_checkins (event_id, user_id, checked_in_at, scanned_by)
    select r.event_id, r.user_id, e.starts_at + interval '11 minutes', null
    from public.member_event_rsvps r
    join public.member_events e on e.id = r.event_id
    join private.presg_demo_ledger l on l.user_id = r.user_id
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and e.chapter_id = 'presg'
      and e.starts_at < pg_catalog.now()
      and r.status = 'going'
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':presg:ci:' || r.event_id) < 0.66
    on conflict (event_id, user_id) do nothing;

    insert into public.member_ballot_votes (ballot_id, option_id, user_id, submitted_at)
    select b.id, o.id, l.user_id,
      coalesce(b.closed_at, pg_catalog.now())
        - ((1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':presg:bd:' || b.id, 12)) || ' days')::interval
    from private.presg_demo_ledger l
    cross join public.member_ballots b
    join public.member_ballot_options o on o.ballot_id = b.id
      and o.order_index = 1 + case
        when private.member_stress_rand(seed || ':' || l.ordinal::text || ':presg:bo:' || b.id) < 0.78 then 0
        when private.member_stress_rand(seed || ':' || l.ordinal::text || ':presg:bo:' || b.id) < 0.93 then 1
        else 2 end
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and b.id like 'presg-ballot-%'
      and private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) < b.closes_at - interval '2 days'
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':presg:bv:' || b.id)
        < case when l.committee then 0.97
            when b.active then 0.42
            else 0.35 + 0.45 * least(extract(epoch from (b.closes_at - (pg_catalog.now() - interval '1460 days')))
              / extract(epoch from interval '1460 days'), 1.0) end
    on conflict (ballot_id, user_id) do nothing;

    insert into public.member_ballot_receipts (id, ballot_id, user_id, receipt_code, counted, issued_at)
    select
      private.member_stress_uuid(seed || ':' || l.ordinal::text || ':presg:brc:' || v.ballot_id),
      v.ballot_id, v.user_id,
      private.presg_demo_receipt_code(seed || ':' || l.ordinal::text || ':presg:brcode:' || v.ballot_id),
      true, v.submitted_at
    from public.member_ballot_votes v
    join private.presg_demo_ledger l on l.user_id = v.user_id
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and v.ballot_id like 'presg-ballot-%'
    on conflict (ballot_id, user_id) do nothing;

    insert into public.member_survey_responses (survey_id, option_id, user_id, submitted_at)
    select s.id, o.id, l.user_id,
      coalesce(s.closed_at, pg_catalog.now())
        - ((1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':presg:sd:' || s.id, 12)) || ' days')::interval
    from private.presg_demo_ledger l
    cross join public.member_surveys s
    join public.member_survey_options o on o.survey_id = s.id
      and o.order_index = 1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':presg:so:' || s.id,
        (select pg_catalog.count(*)::integer from public.member_survey_options o2 where o2.survey_id = s.id))
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and s.id like 'presg-pulse-%'
      and private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) < s.closes_at - interval '2 days'
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':presg:sv:' || s.id)
        < case when l.committee then 0.95 when s.active then 0.30 else 0.55 end
    on conflict (survey_id, user_id) do nothing;

    insert into public.member_broadcast_receipts (broadcast_id, user_id, read_at)
    select b.id, l.user_id,
      b.published_at + ((private.member_stress_pick(seed || ':' || l.ordinal::text || ':presg:brr:' || b.id, 96) + 2) || ' hours')::interval
    from private.presg_demo_ledger l
    cross join public.member_broadcasts b
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and b.id like 'presg-bc-%'
      and private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) < b.published_at
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':presg:brd:' || b.id)
        < case when l.committee then 0.9 else 0.6 end
    on conflict (broadcast_id, user_id) do nothing;

    insert into public.member_forms (id, user_id, template_key, template_version, status, answers, step,
      submitted_at, created_at, updated_at)
    select
      private.member_stress_uuid(t.s || ':presg:form:' || f.slot::text),
      t.user_id, ft.key, ft.version,
      (array['approved', 'approved', 'submitted', 'draft'])[1 + private.member_stress_pick(t.s || ':presg:fs:' || f.slot::text, 4)],
      '{}'::jsonb, 0,
      case when (array['approved', 'approved', 'submitted', 'draft'])[1 + private.member_stress_pick(t.s || ':presg:fs:' || f.slot::text, 4)] = 'draft'
        then null else t.joined + ((30 + private.member_stress_pick(t.s || ':presg:fd:' || f.slot::text, 300)) || ' days')::interval end,
      t.joined + ((30 + private.member_stress_pick(t.s || ':presg:fd:' || f.slot::text, 300)) || ' days')::interval,
      t.joined + ((30 + private.member_stress_pick(t.s || ':presg:fd:' || f.slot::text, 300)) || ' days')::interval
    from (
      select l.ordinal, l.user_id, l.committee, seed || ':' || l.ordinal::text as s,
        private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) as joined
      from private.presg_demo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ) t
    cross join (values (1), (2)) f(slot)
    join lateral (
      select ftpl.key, ftpl.version from public.form_templates ftpl where ftpl.active and ftpl.is_platform_seed
      order by ftpl.key
      offset private.member_stress_pick(t.s || ':presg:ft:' || f.slot::text,
        greatest((select pg_catalog.count(*)::integer from public.form_templates where active and is_platform_seed), 1))
      limit 1
    ) ft on true
    where (f.slot = 1 and (t.committee or private.member_stress_rand(t.s || ':presg:hasform') < 0.22))
       or (f.slot = 2 and t.committee)
    on conflict (id) do nothing;

    insert into public.member_workload_logs (id, user_id, priority, pending, unread_docs, todos, referrals,
      ce_activities, assistance_requests, aged_cases, weekly_assigned, employment, pt_hours, receipt_code,
      created_at, logged_on)
    select
      private.member_stress_uuid(t.s || ':presg:wl'),
      t.user_id,
      private.member_stress_pick(t.s || ':presg:wp', 10),
      private.member_stress_pick(t.s || ':presg:wpe', 30),
      private.member_stress_pick(t.s || ':presg:wu', 20),
      private.member_stress_pick(t.s || ':presg:wt', 25),
      private.member_stress_pick(t.s || ':presg:wr', 10),
      private.member_stress_pick(t.s || ':presg:wc', 6),
      private.member_stress_pick(t.s || ':presg:wa', 8),
      private.member_stress_pick(t.s || ':presg:wg', 12),
      10 + private.member_stress_pick(t.s || ':presg:ww', 20),
      case when private.member_stress_rand(t.s || ':presg:we') < 0.85 then 'full_time' else 'part_time' end,
      case when private.member_stress_rand(t.s || ':presg:we') < 0.85 then null
        else (16 + private.member_stress_pick(t.s || ':presg:wph', 24))::smallint end,
      pg_catalog.substr(pg_catalog.md5(t.s || ':presg:wrc'), 1, 8),
      pg_catalog.now() - ((private.member_stress_pick(t.s || ':presg:wd', 90) + 1) || ' days')::interval,
      (pg_catalog.now() - ((private.member_stress_pick(t.s || ':presg:wd', 90) + 1) || ' days')::interval)::date
    from (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.presg_demo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ) t
    where private.member_stress_rand(t.s || ':presg:haswl') < 0.15
    on conflict (id) do nothing;

  elsif p_phase = 'history' then
    -- Backdated activity: the action log stays action_kind 'seed' so the
    -- award trigger returns immediately; points are minted directly with
    -- occurred_at at least 8 days back, outside every weekly cap window.
    insert into public.member_action_log (id, user_id, action_key, action_kind, occurred_at)
    select
      private.member_stress_uuid(t.s || ':presg:log:' || g.i::text),
      t.user_id, 'presg-log-' || t.ordinal::text || '-' || g.i::text, 'seed',
      t.joined + ((private.member_stress_pick(t.s || ':presg:logd:' || g.i::text,
        greatest(t.age_days - 2, 1))) || ' days')::interval
    from (
      select l.ordinal, l.user_id, l.committee, seed || ':' || l.ordinal::text as s,
        private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) as joined,
        (extract(epoch from (pg_catalog.now() - private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count))) / 86400)::integer as age_days
      from private.presg_demo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ) t
    cross join lateral generate_series(1,
      case when t.committee then 30 + private.member_stress_pick(t.s || ':presg:logn', 30)
           else 6 + private.member_stress_pick(t.s || ':presg:logn', 14) end) g(i)
    on conflict (id) do nothing;
    get diagnostics touched = row_count;

    insert into public.member_point_events (id, user_id, action_key, action_kind, points, occurred_at)
    select
      private.member_stress_uuid(t.s || ':presg:pt:' || g.i::text),
      t.user_id, 'presg-hist-' || t.ordinal::text || '-' || g.i::text,
      (array['message', 'rsvp', 'checkin', 'survey', 'vote', 'rights', 'case', 'steward'])
        [1 + private.member_stress_pick(t.s || ':presg:ptk:' || g.i::text, 8)],
      (array[2, 5, 8, 10, 15, 20, 25, 40])[1 + private.member_stress_pick(t.s || ':presg:ptk:' || g.i::text, 8)],
      pg_catalog.now() - ((8 + private.member_stress_pick(t.s || ':presg:ptd:' || g.i::text,
        greatest(t.age_days - 10, 1))) || ' days')::interval
    from (
      select l.ordinal, l.user_id, l.committee, seed || ':' || l.ordinal::text as s,
        (extract(epoch from (pg_catalog.now() - private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count))) / 86400)::integer as age_days
      from private.presg_demo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ) t
    cross join lateral generate_series(1,
      case when t.committee then 40 + private.member_stress_pick(t.s || ':presg:ptn', 70)
           else 1 + private.member_stress_pick(t.s || ':presg:ptn', 18) end) g(i)
    on conflict (user_id, action_key) do nothing;

    insert into public.member_rights_progress (lesson_id, user_id, completed_steps)
    select les.id, l.user_id,
      case when l.committee then array[0, 1, 2]
        else case private.member_stress_pick(seed || ':' || l.ordinal::text || ':presg:rp:' || les.id, 3)
          when 0 then array[0]
          when 1 then array[0, 1]
          else array[0, 1, 2]
        end end
    from private.presg_demo_ledger l
    cross join public.member_rights_lessons les
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and (l.committee or private.member_stress_rand(seed || ':' || l.ordinal::text || ':presg:rl:' || les.id) < 0.42)
    on conflict (lesson_id, user_id) do nothing;

    with topics as (
      select * from (values
        (0, 'Can they fire me for organizing?',
            'Retaliation for protected concerted activity is illegal under the NLRA. Document everything and tell a committee member the same day.'),
        (1, 'What is a captive-audience meeting?',
            'A mandatory meeting where management argues against the union. You have rights about what you must answer; here they are with citations.'),
        (2, 'How does a union election work?',
            'Cards, the petition, the campaign window, and the secret-ballot vote — the whole timeline in plain language.'),
        (3, 'What are authorization cards?',
            'A signed card says you want the union to represent you. Signatures are confidential from the employer.'),
        (4, 'Can my manager ask me about the union?',
            'They can talk; they cannot interrogate, threaten, promise or spy. The TIPS rule, explained.'),
        (5, 'What would dues cost?',
            'Nobody pays dues until there is a first contract that members vote to approve.'),
        (6, 'What happens after we win the vote?',
            'Certification, bargaining committee elections, and the survey that sets contract priorities.'),
        (7, 'Is my signature confidential?',
            'Yes — cards go to the labor board, never to the employer.')
      ) v(idx, q, a)
    ),
    gthreads as (
      select t.ordinal, t.user_id, t.s, t.joined, g.i,
        private.member_stress_uuid(t.s || ':presg:gt:' || g.i::text) as thread_id,
        private.member_stress_pick(t.s || ':presg:gtt:' || g.i::text, 8) as topic_idx,
        t.joined + ((10 + private.member_stress_pick(t.s || ':presg:gtd:' || g.i::text,
          greatest(t.age_days - 12, 1))) || ' days')::interval as at
      from (
        select l.ordinal, l.user_id, l.committee, seed || ':' || l.ordinal::text as s,
          private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count) as joined,
          (extract(epoch from (pg_catalog.now() - private.presg_demo_joined_at(p_run_id, l.ordinal, run.committee_count))) / 86400)::integer as age_days
        from private.presg_demo_ledger l
        where l.run_id = p_run_id and l.ordinal between lo and hi
      ) t
      cross join lateral generate_series(1,
        case when t.committee then 2 + private.member_stress_pick(t.s || ':presg:gtn', 3)
             else 1 end) g(i)
      where t.committee or private.member_stress_rand(t.s || ':presg:hasgt') < 0.22
    ),
    thread_ins as (
      insert into public.member_guide_threads (id, user_id, title, created_at, updated_at)
      select g.thread_id, g.user_id, topics.q, g.at, g.at
      from gthreads g join topics on topics.idx = g.topic_idx
      on conflict (id) do nothing
      returning 1
    )
    insert into public.member_guide_messages (id, thread_id, user_id, role, body, created_at)
    select
      private.member_stress_uuid(g.s || ':presg:gm:' || g.i::text || ':' || m.n::text),
      g.thread_id, g.user_id, m.role,
      case when m.role = 'user' then topics.q else topics.a end,
      g.at + m.offs
    from gthreads g
    join topics on topics.idx = g.topic_idx
    cross join (values ('user', interval '0 seconds', 1), ('assistant', interval '8 seconds', 2)) m(role, offs, n)
    on conflict (id) do nothing;

  else
    raise exception 'unknown presg enrichment phase %', p_phase;
  end if;

  return jsonb_build_object('phase', p_phase, 'from', lo, 'to', hi, 'touched', touched);
end;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reactivate_form_template(p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  template_org uuid := (select private.current_member_organization());
  updated integer;
begin
  if caller is null or template_org is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  -- Same per-key lock as upsert: without it, a reactivate racing an upsert can
  -- set active on the PREVIOUS version after the upsert mints a new active one,
  -- leaving two active rows for the key.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('form-template-' || p_key, 509));
  update public.form_templates
    set active = true, updated_at = now(), updated_by = caller
    where key = p_key and organization_id = template_org and version = (select max(version) from public.form_templates where key = p_key and organization_id = template_org);
  get diagnostics updated = row_count;
  if updated = 0 then
    -- Changing a shared default creates an organization-local immutable version.
    -- The shared row and every other organization's version remain untouched.
    insert into public.form_templates
      (key,version,label_en,label_es,blurb_en,blurb_es,icon,points,active,sort,field_schema,updated_by,organization_id)
      select t.key,(select max(version)+1 from public.form_templates where key=p_key),
        t.label_en,t.label_es,t.blurb_en,t.blurb_es,t.icon,t.points,'t'::boolean,t.sort,t.field_schema,caller,template_org
      from public.form_templates t where t.key=p_key and t.is_platform_seed;
    get diagnostics updated = row_count;
    if updated = 0 then
      raise exception 'template not found' using errcode = '22023';
    end if;
  end if;
  return pg_catalog.jsonb_build_object('key', p_key, 'active', true);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.save_form_draft(p_template_key text, p_answers jsonb, p_step integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  existing uuid;
  clean jsonb := coalesce(p_answers, '{}'::jsonb);
  prev_answers jsonb;
  tpl record;
  reaffirmed uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if pg_catalog.jsonb_typeof(clean) <> 'object' or pg_catalog.length(clean::text) > 20000 then
    raise exception 'answers too large' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-form-' || caller::text || '-' || p_template_key, 509));
  select id, answers into existing, prev_answers from public.member_forms
    where user_id = caller and template_key = p_template_key and status in ('draft', 'returned')
    order by updated_at desc limit 1;
  if existing is null then
    -- With no selected organization only platform seeds match below.
    select version,active into tpl from public.form_templates
      where key=p_template_key and (is_platform_seed
        or organization_id=(select private.current_member_organization()))
      order by version desc limit 1;
    if not found then raise exception 'invalid template' using errcode='22023'; end if;
    if not tpl.active then
      raise exception 'this form is no longer accepting new submissions' using errcode = '22023';
    end if;
    insert into public.member_forms (user_id, template_key, template_version, answers, step)
      values (caller, p_template_key, tpl.version, clean,
        least(greatest(coalesce(p_step, 0), 0), 50))
      returning id into existing;
  else
    if clean is distinct from prev_answers then
      delete from private.member_form_signatures where form_id = existing;
      update public.member_forms
        set filer_signed_at = null, filer_signature_digest = null, content_digest = null
        where id = existing;
      if p_template_key = 'alliance_grievance' then
        for reaffirmed in
          update public.member_form_cosigners
            set status='reaffirm_needed', responded_at=now(), signed_at=null, signature_digest=null
            where form_id=existing and status='accepted'
            returning cosigner_user_id
        loop
          if reaffirmed is not null then
            perform private.notify_member(reaffirmed, 'cosign.reaffirm', '{}'::jsonb, 'forms');
          end if;
        end loop;
      end if;
    end if;
    update public.member_forms
      set answers = clean, step = least(greatest(coalesce(p_step, 0), 0), 50), updated_at = now()
      where id = existing and user_id = caller;
  end if;
  return existing;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.uniondemo_enrich_batch(p_run_id uuid, p_phase text, p_start_ordinal integer, p_batch_count integer, p_target_ref text, p_confirm_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '300s'
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  run private.uniondemo_runs%rowtype;
  lo integer := p_start_ordinal;
  hi integer := p_start_ordinal + p_batch_count - 1;
  touched bigint := 0;
  seed text := p_run_id::text;
  t0 timestamptz := pg_catalog.now() - interval '1460 days';
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  if p_batch_count not between 1 and 2000 or p_start_ordinal < 1 then
    raise exception 'invalid enrichment batch range';
  end if;
  select * into run from private.uniondemo_runs where id = p_run_id;
  if not found then raise exception 'unknown union demo run'; end if;
  if run.state not in ('applied', 'verified') then
    raise exception 'run must be applied to enrich (state %)', run.state;
  end if;

  if p_phase = 'roles' then
    -- Stewards, chapter officers and the org VP, all chapter-scoped. Steward
    -- appointment desks (schedule + weekly windows) ride along so the booking
    -- surfaces are live.
    insert into public.member_roles (user_id, role, chapter_id, granted_at, granted_by)
    select l.user_id, 'steward', l.chapter_id,
      greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward) + interval '60 days', t0 + interval '10 days'), null
    from private.uniondemo_ledger l
    where l.run_id = p_run_id and l.ordinal between lo and hi and l.steward
    on conflict (user_id, role) do nothing;
    get diagnostics touched = row_count;

    insert into public.member_roles (user_id, role, chapter_id, granted_at, granted_by)
    select l.user_id, l.officer, l.chapter_id, t0 + interval '30 days', null
    from private.uniondemo_ledger l
    where l.run_id = p_run_id and l.ordinal between lo and hi and l.officer is not null
    on conflict (user_id, role) do nothing;

    insert into public.member_role_chapters (user_id, role, chapter_id, granted_at, granted_by)
    select r.user_id, r.role, l.chapter_id, r.granted_at, r.granted_by
    from public.member_roles r
    join private.uniondemo_ledger l on l.user_id = r.user_id and l.run_id = p_run_id
    where l.ordinal between lo and hi
    on conflict (user_id, role, chapter_id) do nothing;

    insert into public.organization_role_grants (organization_id, user_id, role, granted_at, granted_by)
    select private.member_stress_uuid(p_run_id::text || ':ud:organization'), r.user_id, r.role,
      r.granted_at, r.granted_by
    from public.member_roles r
    join private.uniondemo_ledger l on l.user_id = r.user_id and l.run_id = p_run_id
    where l.ordinal between lo and hi
    on conflict (organization_id, user_id, role) do nothing;

    insert into public.member_appointment_schedules
      (steward_id, timezone, min_notice_minutes, buffer_before_minutes, buffer_after_minutes, max_per_day, accepting, created_at, updated_at)
    select l.user_id, 'America/New_York', 240, 10, 10, 6, true, t0 + interval '30 days', t0 + interval '30 days'
    from private.uniondemo_ledger l
    where l.run_id = p_run_id and l.ordinal between lo and hi and l.steward
    on conflict (steward_id) do nothing;

    insert into public.member_appointment_windows (id, steward_id, weekday, start_minute, end_minute)
    select
      private.member_stress_uuid(seed || ':ud:apwin:' || l.ordinal::text || ':' || w.n::text),
      l.user_id,
      ((l.ordinal + w.n * 2) % 5) + 1,
      540 + ((l.ordinal + w.n) % 4) * 60,
      780 + ((l.ordinal + w.n) % 4) * 60
    from private.uniondemo_ledger l
    cross join (values (1), (2)) w(n)
    where l.run_id = p_run_id and l.ordinal between lo and hi and l.steward
    on conflict (id) do nothing;

  elsif p_phase = 'texture' then
    -- Conversations with the chapter steward team plus the notification feed.
    -- Seeded notifications stay kind 'general' — the outbound rule at the top
    -- of this file.
    with tgt as (
      select l.ordinal, l.user_id, l.steward, l.chapter_index, seed || ':' || l.ordinal::text as s,
        greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) as active_from
      from private.uniondemo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    convs as (
      select t.*, slot.n as slot, slot.title, slot.initials,
        private.member_stress_uuid(t.s || ':ud:conv:' || slot.n::text) as conv_id,
        3 + (case when t.steward then 18 else 0 end)
          + private.member_stress_pick(t.s || ':ud:msgs:' || slot.n::text,
              case when t.steward then 40 else 10 end) as msg_count
      from tgt t
      cross join (values
        (1, 'Chapter steward', 'CS'),
        (2, 'Steward team', 'ST'),
        (3, 'Grievance follow-up', 'GF')
      ) slot(n, title, initials)
      where slot.n = 1
        or (slot.n = 2 and t.steward)
        or (slot.n = 3 and not t.steward
            and private.member_stress_rand(t.s || ':ud:conv3') < 0.25)
    ),
    conv_ins as (
      insert into public.member_conversations (id, user_id, title, initials, created_at, updated_at)
      select c.conv_id, c.user_id, c.title, c.initials,
        c.active_from + interval '2 days',
        c.active_from + interval '2 days'
          + (((c.msg_count - 1)::double precision / c.msg_count)
             * extract(epoch from (pg_catalog.now() - interval '1 day' - (c.active_from + interval '2 days'))) || ' seconds')::interval
      from convs c
      on conflict (id) do nothing
      returning 1
    )
    select pg_catalog.count(*) into touched from conv_ins;

    with tgt as (
      select l.ordinal, l.user_id, l.steward, l.chapter_index, seed || ':' || l.ordinal::text as s,
        greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) as active_from
      from private.uniondemo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    convs as (
      select t.*, slot.n as slot,
        private.member_stress_uuid(t.s || ':ud:conv:' || slot.n::text) as conv_id,
        3 + (case when t.steward then 18 else 0 end)
          + private.member_stress_pick(t.s || ':ud:msgs:' || slot.n::text,
              case when t.steward then 40 else 10 end) as msg_count
      from tgt t
      cross join (values (1), (2), (3)) slot(n)
      where slot.n = 1
        or (slot.n = 2 and t.steward)
        or (slot.n = 3 and not t.steward
            and private.member_stress_rand(t.s || ':ud:conv3') < 0.25)
    ),
    msgs as (
      select c.*, m.i,
        c.active_from + interval '2 days'
          + (((m.i - 1)::double precision / c.msg_count)
             * extract(epoch from (pg_catalog.now() - interval '1 day' - (c.active_from + interval '2 days'))) || ' seconds')::interval
          as msg_at,
        private.member_stress_rand(c.s || ':ud:mwho:' || c.slot::text || ':' || m.i::text) < 0.48 as from_member
      from convs c
      cross join lateral generate_series(1, c.msg_count) m(i)
    )
    insert into public.member_messages (id, conversation_id, user_id, sender_kind, sender_name, body, read_at, created_at)
    select
      private.member_stress_uuid(m.s || ':ud:msg:' || m.slot::text || ':' || m.i::text),
      m.conv_id, m.user_id,
      case when m.from_member then 'member' else 'steward' end,
      case when m.from_member
        then private.uniondemo_full_name(p_run_id, m.ordinal)
        else private.uniondemo_full_name(p_run_id,
          (select c2.first_ordinal from private.uniondemo_chapters c2
            where c2.run_id = p_run_id and c2.chapter_index = m.chapter_index)
          + private.member_stress_pick(m.s || ':ud:mstw:' || m.slot::text || ':' || m.i::text,
              (select c2.steward_count from private.uniondemo_chapters c2
                where c2.run_id = p_run_id and c2.chapter_index = m.chapter_index)))
      end,
      (array[
        'My supervisor changed the posted schedule again without the contract notice.',
        'Can you check whether this write-up followed Article 12?',
        'We were short-staffed on the overnight again — third time this month.',
        'I was told to attend a meeting tomorrow. Should a steward come?',
        'The overtime list skipped me twice. Who tracks equalization?',
        'My telework day was cancelled without the notice window.',
        'Thanks for flagging it — I pulled the posted schedule and I am comparing it against Article 8.',
        'Bring every notice they handed you; receipt is not agreement.',
        'I filed the paperwork today and copied the coordinator.',
        'Yes — do not answer substantive questions until I am in the room.',
        'The employer owes a written answer by the end of next week.',
        'Logged. If it happens again this pay period we escalate to Step 2.',
        'The grievance clinic has openings Thursday — want me to book you in?',
        'Your Step 2 hearing is confirmed for next Tuesday at 10.',
        'The back-pay award landed — check your next stub and tell me if it is short.',
        'New steward office hours start Wednesday at noon on Zoom.',
        'I read the rights lesson — the investigatory meeting part was new to me.',
        'Adding two names to the turnout list now.',
        'Done. Both conversations went better than expected.',
        'See you Thursday at the chapter meeting.'
      ])[1 + private.member_stress_pick(m.s || ':ud:mbody:' || m.slot::text || ':' || m.i::text, 20)],
      case when m.i >= m.msg_count - 1 and not m.from_member
             and private.member_stress_rand(m.s || ':ud:mrd:' || m.slot::text || ':' || m.i::text) < 0.55
        then null
        else m.msg_at + interval '9 hours' end,
      m.msg_at
    from msgs m
    on conflict (id) do nothing;

    with tgt as (
      select l.ordinal, l.user_id, l.steward, seed || ':' || l.ordinal::text as s
      from private.uniondemo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    feed as (
      select t.*, n.i,
        pg_catalog.now()
          - ((pg_catalog.floor(pg_catalog.power(private.member_stress_rand(t.s || ':ud:nage:' || n.i::text), 2) * 200) + 1) || ' days')::interval
          - ((private.member_stress_pick(t.s || ':ud:nhr:' || n.i::text, 22) + 1) || ' hours')::interval as at
      from tgt t
      cross join lateral generate_series(1,
        case when t.steward then 20 + private.member_stress_pick(t.s || ':ud:nn', 24)
             else 5 + private.member_stress_pick(t.s || ':ud:nn', 12) end) n(i)
    )
    insert into public.member_notifications (id, user_id, title, body, kind, read_at, created_at)
    select
      private.member_stress_uuid(f.s || ':ud:ntf:' || f.i::text),
      f.user_id,
      (array[
        'Ballot closes soon',
        'New chapter update',
        'Event reminder',
        'Case update posted',
        'Steward replied',
        'Form status changed',
        'New reply in your chapter thread',
        'Steward office hours tomorrow',
        'Grievance clinic openings',
        'New rights lesson available'
      ])[1 + private.member_stress_pick(f.s || ':ud:nti:' || f.i::text, 10)],
      (array[
        'Cast your vote before the chapter ballot closes this week.',
        'The latest chapter broadcast is ready in your feed.',
        'A chapter event you RSVP''d to starts soon.',
        'Your steward posted an update on your open case.',
        'Your steward answered your message — read it when you can.',
        'A form you filed moved to its next status.',
        'A steward replied to the thread you follow.',
        'Weekly office hours run at noon on Zoom and at the office.',
        'Drop-in slots are open this Thursday; a steward will help you file.',
        'Three minutes on your rights in investigatory meetings.'
      ])[1 + private.member_stress_pick(f.s || ':ud:nbo:' || f.i::text, 10)],
      'general',
      case when private.member_stress_rand(f.s || ':ud:nrd:' || f.i::text) < 0.66
        then f.at + ((1 + private.member_stress_pick(f.s || ':ud:nrh:' || f.i::text, 60)) || ' hours')::interval
        else null end,
      f.at
    from feed f
    on conflict (id) do nothing;

  elsif p_phase = 'casework' then
    -- Grievances worked by chapter stewards under the contract, plus steward
    -- requests and the appointment desks' bookings.
    with tgt as (
      select l.ordinal, l.user_id, l.steward, l.chapter_index, seed || ':' || l.ordinal::text as s,
        greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) as active_from,
        c.first_ordinal, c.steward_count
      from private.uniondemo_ledger l
      join private.uniondemo_chapters c on c.run_id = l.run_id and c.chapter_index = l.chapter_index
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    cased as (
      select t.*, c.slot,
        private.member_stress_uuid(t.s || ':ud:case:' || c.slot::text) as case_id,
        private.member_stress_pick(t.s || ':ud:ctype:' || c.slot::text, 6) as type_idx,
        t.active_from + interval '15 days'
          + ((private.member_stress_pick(t.s || ':ud:cage:' || c.slot::text,
              greatest((extract(epoch from (pg_catalog.now() - t.active_from)) / 86400)::integer - 25, 1))) || ' days')::interval as opened,
        t.first_ordinal + private.member_stress_pick(t.s || ':ud:cstw:' || c.slot::text, t.steward_count) as steward_ordinal
      from tgt t
      cross join (values (1), (2)) c(slot)
      where (c.slot = 1 and private.member_stress_rand(t.s || ':ud:hascase')
              < case when t.steward then 0.40 else 0.26 end)
         or (c.slot = 2 and private.member_stress_rand(t.s || ':ud:hascase2') < 0.07)
    ),
    case_ins as (
      insert into public.member_cases (id, user_id, reference, title, deadline, case_type, articles, step,
        status, steward_user_id, steward_name, coordinator_user_id, coordinator_name,
        assigned_at, created_at, updated_at,
        deadline_notice_7_sent_at, deadline_notice_3_sent_at, deadline_notice_1_sent_at)
      select
        c.case_id, c.user_id,
        'UD-' || pg_catalog.to_char(c.opened, 'YYYY') || '-' || pg_catalog.lpad((c.ordinal * 2 - 2 + c.slot)::text, 6, '0'),
        (array[
          'Schedule changed without notice',
          'Overtime equalization skipped',
          'Discipline without just cause',
          'Telework day cancelled',
          'Unsafe staffing on the unit',
          'Retaliation after filing'
        ])[1 + c.type_idx],
        case when c.opened > pg_catalog.now() - interval '75 days'
          then (pg_catalog.now() + ((5 + private.member_stress_pick(c.s || ':ud:cdl:' || c.slot::text, 40)) || ' days')::interval)::date
          else (c.opened + interval '45 days')::date end,
        (array['Scheduling', 'Overtime', 'Discipline', 'Telework', 'Safety', 'Retaliation'])[1 + c.type_idx],
        (array[
          'Article 7 — Hours of Work',
          'Article 8.3 — Overtime equalization',
          'Article 12 — Discipline · Article 3 — Union Rights',
          'Article 15 — Telework',
          'Article 16 — Health and Safety',
          'Article 12 — Discipline · Article 3 — Union Rights'
        ])[1 + c.type_idx],
        case when c.opened > pg_catalog.now() - interval '75 days'
          then (array['Step 1', 'Step 2', 'Step 2', 'Step 3'])
            [1 + private.member_stress_pick(c.s || ':ud:cstep:' || c.slot::text, 4)]
          else 'Closed' end,
        case when c.opened > pg_catalog.now() - interval '75 days' then 'active' else 'resolved' end,
        private.uniondemo_user_id(p_run_id, c.steward_ordinal),
        private.uniondemo_full_name(p_run_id, c.steward_ordinal),
        private.uniondemo_user_id(p_run_id, c.first_ordinal),
        private.uniondemo_full_name(p_run_id, c.first_ordinal),
        c.opened + interval '2 days',
        c.opened,
        c.opened + interval '9 days',
        case when c.opened > pg_catalog.now() - interval '75 days' then null else c.opened + interval '38 days' end,
        case when c.opened > pg_catalog.now() - interval '75 days' then null else c.opened + interval '42 days' end,
        case when c.opened > pg_catalog.now() - interval '75 days' then null else c.opened + interval '44 days' end
      from cased c
      on conflict (id) do nothing
      returning 1
    )
    select pg_catalog.count(*) into touched from case_ins;

    insert into public.member_case_updates (id, case_id, user_id, body, created_at)
    select
      private.member_stress_uuid(l.user_id::text || ':ud:cu:' || c.id::text || ':' || g.i::text),
      c.id, c.user_id,
      (array[
        'Logged the incident with dates, shifts and witnesses.',
        'Step 1 filed; the employer''s written answer is due in 10 days.',
        'Step 1 denied without records; appealing to Step 2.',
        'Step 2 hearing held; we documented the just-cause defects.',
        'Settled — schedule restored and back pay agreed. Keeping the documentation.',
        'Escalating: three coworkers reported the same violation this month.'
      ])[1 + private.member_stress_pick(seed || ':ud:cub:' || c.id::text || ':' || g.i::text, 6)],
      c.created_at + ((g.i * (5 + private.member_stress_pick(seed || ':ud:cud:' || c.id::text || ':' || g.i::text, 12))) || ' days')::interval
    from private.uniondemo_ledger l
    join public.member_cases c on c.user_id = l.user_id
    cross join lateral generate_series(1, 1 + private.member_stress_pick(seed || ':ud:cun:' || c.id::text, 3)) g(i)
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and c.reference like 'UD-%'
    on conflict (id) do nothing;

    -- Steward requests, inserted in FINAL status (the award-on-acknowledgment
    -- trigger is UPDATE-only and must stay silent).
    insert into public.member_steward_requests (id, user_id, lesson_id, status, created_at, acknowledged_at, closed_at, handled_by)
    select
      private.member_stress_uuid(t.s || ':ud:sreq'),
      t.user_id,
      case when private.member_stress_rand(t.s || ':ud:srl') < 0.5 then null
        else (select les.id from public.member_rights_lessons les
          order by les.id
          offset private.member_stress_pick(t.s || ':ud:srlx',
            greatest((select pg_catalog.count(*)::integer from public.member_rights_lessons), 1))
          limit 1) end,
      case when private.member_stress_rand(t.s || ':ud:srs') < 0.10 then 'requested'
           when private.member_stress_rand(t.s || ':ud:srs') < 0.52 then 'acknowledged'
           else 'closed' end,
      case when private.member_stress_rand(t.s || ':ud:srs') < 0.10
        then pg_catalog.now() - ((1 + private.member_stress_pick(t.s || ':ud:srd', 9)) || ' days')::interval
        else t.active_from + interval '15 days'
          + ((private.member_stress_pick(t.s || ':ud:srd',
              greatest((extract(epoch from (pg_catalog.now() - t.active_from)) / 86400)::integer - 20, 1))) || ' days')::interval
      end,
      case when private.member_stress_rand(t.s || ':ud:srs') >= 0.10
        then t.active_from + interval '16 days' end,
      case when private.member_stress_rand(t.s || ':ud:srs') >= 0.52
        then t.active_from + interval '19 days' end,
      private.uniondemo_user_id(p_run_id, t.first_ordinal + private.member_stress_pick(t.s || ':ud:srh', t.steward_count))
    from (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s,
        greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) as active_from,
        c.first_ordinal, c.steward_count
      from private.uniondemo_ledger l
      join private.uniondemo_chapters c on c.run_id = l.run_id and c.chapter_index = l.chapter_index
      where l.run_id = p_run_id and l.ordinal between lo and hi and not l.steward
    ) t
    where private.member_stress_rand(t.s || ':ud:hasreq') < 0.38
    on conflict (id) do nothing;

    -- Appointment history: past appointments are completed/no_show (ignored
    -- by the exclusion constraints); every steward gets exactly ONE upcoming
    -- confirmed booking, booked by the member sitting steward_count positions
    -- after them in the block, in a slot derived from the steward's own block
    -- position — disjoint by construction.
    insert into public.member_appointments (id, user_id, steward_id, chapter_id, appointment_type,
      duration_minutes, starts_at, ends_at, status, routed_via, reason_category, created_at, updated_at)
    select
      private.member_stress_uuid(t.s || ':ud:appt:past'),
      t.user_id,
      private.uniondemo_user_id(p_run_id, t.first_ordinal + private.member_stress_pick(t.s || ':ud:apstw', t.steward_count)),
      t.chapter_id,
      (array['office_hours', 'grievance_followup', 'onboarding', 'contract_questions'])
        [1 + private.member_stress_pick(t.s || ':ud:aptype', 4)],
      (array[20, 30, 45])[1 + private.member_stress_pick(t.s || ':ud:apdur', 3)]::smallint,
      t.past_at,
      t.past_at + ((array[20, 30, 45])[1 + private.member_stress_pick(t.s || ':ud:apdur', 3)] || ' minutes')::interval,
      case when private.member_stress_rand(t.s || ':ud:apst') < 0.88 then 'completed' else 'no_show' end,
      case when private.member_stress_rand(t.s || ':ud:aprt') < 0.5 then 'steward' else 'chapter' end,
      (array['general', 'pay', 'scheduling', 'safety', 'discipline'])
        [1 + private.member_stress_pick(t.s || ':ud:aprc', 5)],
      t.past_at - interval '6 days',
      t.past_at
    from (
      select l.ordinal, l.user_id, l.chapter_id, seed || ':' || l.ordinal::text as s,
        c.first_ordinal, c.steward_count,
        pg_catalog.date_trunc('hour',
          greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0)
          + interval '30 days'
          + ((private.member_stress_pick(seed || ':' || l.ordinal::text || ':ud:apd',
              greatest((extract(epoch from (pg_catalog.now()
                - greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0))) / 86400)::integer - 40, 1))) || ' days')::interval) as past_at
      from private.uniondemo_ledger l
      join private.uniondemo_chapters c on c.run_id = l.run_id and c.chapter_index = l.chapter_index
      where l.run_id = p_run_id and l.ordinal between lo and hi
        and private.member_stress_rand(seed || ':' || l.ordinal::text || ':ud:hasappt') < 0.20
        -- Members active less than ~45 days would produce a "completed"
        -- appointment dated in the future; they simply have none yet.
        and greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0)
          < pg_catalog.now() - interval '45 days'
    ) t
    on conflict (id) do nothing;

    insert into public.member_appointments (id, user_id, steward_id, chapter_id, appointment_type,
      duration_minutes, starts_at, ends_at, status, routed_via, reason_category, created_at, updated_at)
    select
      private.member_stress_uuid(seed || ':ud:appt:up:' || s.ordinal::text),
      b.user_id,
      s.user_id,
      s.chapter_id,
      'contract_questions', 30::smallint,
      up.starts_at, up.starts_at + interval '30 minutes',
      'confirmed',
      'chapter', 'general',
      pg_catalog.now() - interval '2 days',
      pg_catalog.now() - interval '2 days'
    from private.uniondemo_ledger s
    join private.uniondemo_chapters c on c.run_id = s.run_id and c.chapter_index = s.chapter_index
    join private.uniondemo_ledger b on b.run_id = s.run_id and b.ordinal = s.ordinal + c.steward_count
    cross join lateral (
      select pg_catalog.date_trunc('day', pg_catalog.now())
        + ((3 + ((s.ordinal - c.first_ordinal) % 10)) || ' days')::interval
        + ((9 + (((s.ordinal - c.first_ordinal) / 10) % 8)) || ' hours')::interval as starts_at
    ) up
    where s.run_id = p_run_id and s.ordinal between lo and hi and s.steward
      and b.chapter_index = s.chapter_index
      and not exists (select 1 from public.member_appointments a
        where a.id = private.member_stress_uuid(seed || ':ud:appt:up:' || s.ordinal::text));

    insert into public.member_appointment_events (id, appointment_id, actor, action, detail, created_at)
    select
      private.member_stress_uuid(seed || ':ud:apev:' || a.id::text),
      a.id, a.user_id, 'booked', '{}'::jsonb, a.created_at
    from public.member_appointments a
    join private.uniondemo_ledger l on l.user_id = a.user_id
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and a.chapter_id like 'ud-%'
    on conflict (id) do nothing;

    perform private.uniondemo_sweep_trigger_rows(p_run_id);

  elsif p_phase = 'participation' then
    -- Participation in the member's OWN chapter, scaled by recency so the
    -- curves rise; nobody participates in anything dated before they were
    -- active. Stewards participate at near-total rates.
    insert into public.member_event_rsvps (event_id, user_id, status, created_at, updated_at)
    select e.id, l.user_id,
      case when private.member_stress_rand(seed || ':' || l.ordinal::text || ':ud:rs:' || e.id) < 0.9
        then 'going' else 'not_going' end,
      e.starts_at - ((2 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':ud:rt:' || e.id, 10)) || ' days')::interval,
      e.starts_at - ((2 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':ud:rt:' || e.id, 10)) || ' days')::interval
    from private.uniondemo_ledger l
    join public.member_events e on e.chapter_id = l.chapter_id
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and e.id like 'ud-evt-%'
      and greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) < e.starts_at - interval '3 days'
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':ud:rv:' || e.id)
        < case when l.steward then 0.85
            else 0.06 + 0.20 * greatest(least(extract(epoch from (e.starts_at - t0))
              / extract(epoch from interval '1460 days'), 1.0), 0.0) end
    on conflict (event_id, user_id) do nothing;
    get diagnostics touched = row_count;

    insert into public.member_event_checkins (event_id, user_id, checked_in_at, scanned_by)
    select r.event_id, r.user_id, e.starts_at + interval '11 minutes', null
    from public.member_event_rsvps r
    join public.member_events e on e.id = r.event_id
    join private.uniondemo_ledger l on l.user_id = r.user_id
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and e.id like 'ud-evt-%'
      and e.starts_at < pg_catalog.now()
      and r.status = 'going'
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':ud:ci:' || r.event_id) < 0.64
    on conflict (event_id, user_id) do nothing;

    insert into public.member_ballot_votes (ballot_id, option_id, user_id, submitted_at)
    select b.id, o.id, l.user_id,
      coalesce(b.closed_at, pg_catalog.now())
        - ((1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':ud:bd:' || b.id, 12)) || ' days')::interval
    from private.uniondemo_ledger l
    join public.member_ballots b on b.chapter_id = l.chapter_id
    join public.member_ballot_options o on o.ballot_id = b.id
      and o.order_index = 1 + case
        when private.member_stress_rand(seed || ':' || l.ordinal::text || ':ud:bo:' || b.id) < 0.72 then 0
        when private.member_stress_rand(seed || ':' || l.ordinal::text || ':ud:bo:' || b.id) < 0.92 then 1
        else 2 end
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and b.id like 'ud-ballot-%'
      and greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) < b.closes_at - interval '2 days'
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':ud:bv:' || b.id)
        < case when l.steward then 0.96
            when b.active then 0.38
            else 0.30 + 0.35 * greatest(least(extract(epoch from (b.closes_at - t0))
              / extract(epoch from interval '1460 days'), 1.0), 0.0) end
    on conflict (ballot_id, user_id) do nothing;

    insert into public.member_ballot_receipts (id, ballot_id, user_id, receipt_code, counted, issued_at)
    select
      private.member_stress_uuid(seed || ':' || l.ordinal::text || ':ud:brc:' || v.ballot_id),
      v.ballot_id, v.user_id,
      private.uniondemo_receipt_code(seed || ':' || l.ordinal::text || ':ud:brcode:' || v.ballot_id),
      true, v.submitted_at
    from public.member_ballot_votes v
    join private.uniondemo_ledger l on l.user_id = v.user_id
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and v.ballot_id like 'ud-ballot-%'
    on conflict (ballot_id, user_id) do nothing;

    insert into public.member_survey_responses (survey_id, option_id, user_id, submitted_at)
    select s.id, o.id, l.user_id,
      coalesce(s.closed_at, pg_catalog.now())
        - ((1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':ud:sd:' || s.id, 12)) || ' days')::interval
    from private.uniondemo_ledger l
    join public.member_surveys s on s.chapter_id = l.chapter_id
    join public.member_survey_options o on o.survey_id = s.id
      and o.order_index = 1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':ud:so:' || s.id,
        (select pg_catalog.count(*)::integer from public.member_survey_options o2 where o2.survey_id = s.id))
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and s.id like 'ud-pulse-%'
      and greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) < s.closes_at - interval '2 days'
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':ud:sv:' || s.id)
        < case when l.steward then 0.92 when s.active then 0.28 else 0.45 end
    on conflict (survey_id, user_id) do nothing;

    insert into public.member_broadcast_receipts (broadcast_id, user_id, read_at)
    select b.id, l.user_id,
      b.published_at + ((private.member_stress_pick(seed || ':' || l.ordinal::text || ':ud:brr:' || b.id, 96) + 2) || ' hours')::interval
    from private.uniondemo_ledger l
    cross join public.member_broadcasts b
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and b.id like 'ud-bc-%'
      and greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) < b.published_at
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':ud:brd:' || b.id)
        < case when l.steward then 0.85 else 0.48 end
    on conflict (broadcast_id, user_id) do nothing;

    -- member_forms_one_active_idx allows ONE draft/returned form per
    -- (user, template): slot 2 is always approved, so at most one seeded
    -- draft can ever exist per member.
    insert into public.member_forms (id, user_id, template_key, template_version, status, answers, step,
      submitted_at, created_at, updated_at)
    select
      private.member_stress_uuid(t.s || ':ud:form:' || f.slot::text),
      t.user_id, ft.key, ft.version,
      case when f.slot = 2 then 'approved'
        else (array['approved', 'approved', 'submitted', 'draft'])[1 + private.member_stress_pick(t.s || ':ud:fs:' || f.slot::text, 4)] end,
      '{}'::jsonb, 0,
      case when f.slot <> 2
        and (array['approved', 'approved', 'submitted', 'draft'])[1 + private.member_stress_pick(t.s || ':ud:fs:' || f.slot::text, 4)] = 'draft'
        then null else t.active_from + ((30 + private.member_stress_pick(t.s || ':ud:fd:' || f.slot::text, 300)) || ' days')::interval end,
      t.active_from + ((30 + private.member_stress_pick(t.s || ':ud:fd:' || f.slot::text, 300)) || ' days')::interval,
      t.active_from + ((30 + private.member_stress_pick(t.s || ':ud:fd:' || f.slot::text, 300)) || ' days')::interval
    from (
      select l.ordinal, l.user_id, l.steward, seed || ':' || l.ordinal::text as s,
        greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) as active_from
      from private.uniondemo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ) t
    cross join (values (1), (2)) f(slot)
    join lateral (
      select ftpl.key, ftpl.version from public.form_templates ftpl where ftpl.active and ftpl.is_platform_seed
      order by ftpl.key
      offset private.member_stress_pick(t.s || ':ud:ft:' || f.slot::text,
        greatest((select pg_catalog.count(*)::integer from public.form_templates where active and is_platform_seed), 1))
      limit 1
    ) ft on true
    where (f.slot = 1 and (t.steward or private.member_stress_rand(t.s || ':ud:hasform') < 0.20))
       or (f.slot = 2 and t.steward)
    on conflict (id) do nothing;

    insert into public.member_workload_logs (id, user_id, priority, pending, unread_docs, todos, referrals,
      ce_activities, assistance_requests, aged_cases, weekly_assigned, employment, pt_hours, receipt_code,
      created_at, logged_on)
    select
      private.member_stress_uuid(t.s || ':ud:wl'),
      t.user_id,
      private.member_stress_pick(t.s || ':ud:wp', 10),
      private.member_stress_pick(t.s || ':ud:wpe', 30),
      private.member_stress_pick(t.s || ':ud:wu', 20),
      private.member_stress_pick(t.s || ':ud:wt', 25),
      private.member_stress_pick(t.s || ':ud:wr', 10),
      private.member_stress_pick(t.s || ':ud:wc', 6),
      private.member_stress_pick(t.s || ':ud:wa', 8),
      private.member_stress_pick(t.s || ':ud:wg', 12),
      10 + private.member_stress_pick(t.s || ':ud:ww', 20),
      case when private.member_stress_rand(t.s || ':ud:we') < 0.85 then 'full_time' else 'part_time' end,
      case when private.member_stress_rand(t.s || ':ud:we') < 0.85 then null
        else (16 + private.member_stress_pick(t.s || ':ud:wph', 24))::smallint end,
      pg_catalog.substr(pg_catalog.md5(t.s || ':ud:wrc'), 1, 8),
      pg_catalog.now() - ((private.member_stress_pick(t.s || ':ud:wd', 90) + 1) || ' days')::interval,
      (pg_catalog.now() - ((private.member_stress_pick(t.s || ':ud:wd', 90) + 1) || ' days')::interval)::date
    from (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.uniondemo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ) t
    where private.member_stress_rand(t.s || ':ud:haswl') < 0.14
    on conflict (id) do nothing;

  elsif p_phase = 'history' then
    -- Backdated activity: the action log stays action_kind 'seed' so the
    -- award trigger returns immediately; points are minted directly with
    -- occurred_at at least 8 days back, outside every weekly cap window.
    insert into public.member_action_log (id, user_id, action_key, action_kind, occurred_at)
    select
      private.member_stress_uuid(t.s || ':ud:log:' || g.i::text),
      t.user_id, 'ud-log-' || t.ordinal::text || '-' || g.i::text, 'seed',
      t.active_from + ((private.member_stress_pick(t.s || ':ud:logd:' || g.i::text,
        greatest(t.age_days - 2, 1))) || ' days')::interval
    from (
      select l.ordinal, l.user_id, l.steward, seed || ':' || l.ordinal::text as s,
        greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) as active_from,
        (extract(epoch from (pg_catalog.now() - greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0))) / 86400)::integer as age_days
      from private.uniondemo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ) t
    cross join lateral generate_series(1,
      case when t.steward then 24 + private.member_stress_pick(t.s || ':ud:logn', 30)
           else 5 + private.member_stress_pick(t.s || ':ud:logn', 12) end) g(i)
    on conflict (id) do nothing;
    get diagnostics touched = row_count;

    insert into public.member_point_events (id, user_id, action_key, action_kind, points, occurred_at)
    select
      private.member_stress_uuid(t.s || ':ud:pt:' || g.i::text),
      t.user_id, 'ud-hist-' || t.ordinal::text || '-' || g.i::text,
      (array['message', 'rsvp', 'checkin', 'survey', 'vote', 'rights', 'case', 'steward'])
        [1 + private.member_stress_pick(t.s || ':ud:ptk:' || g.i::text, 8)],
      (array[2, 5, 8, 10, 15, 20, 25, 40])[1 + private.member_stress_pick(t.s || ':ud:ptk:' || g.i::text, 8)],
      pg_catalog.now() - ((8 + private.member_stress_pick(t.s || ':ud:ptd:' || g.i::text,
        greatest(t.age_days - 10, 1))) || ' days')::interval
    from (
      select l.ordinal, l.user_id, l.steward, seed || ':' || l.ordinal::text as s,
        (extract(epoch from (pg_catalog.now() - greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0))) / 86400)::integer as age_days
      from private.uniondemo_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ) t
    cross join lateral generate_series(1,
      case when t.steward then 36 + private.member_stress_pick(t.s || ':ud:ptn', 60)
           else 1 + private.member_stress_pick(t.s || ':ud:ptn', 15) end) g(i)
    on conflict (user_id, action_key) do nothing;

    insert into public.member_rights_progress (lesson_id, user_id, completed_steps)
    select les.id, l.user_id,
      case when l.steward then array[0, 1, 2]
        else case private.member_stress_pick(seed || ':' || l.ordinal::text || ':ud:rp:' || les.id, 3)
          when 0 then array[0]
          when 1 then array[0, 1]
          else array[0, 1, 2]
        end end
    from private.uniondemo_ledger l
    cross join public.member_rights_lessons les
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and (l.steward or private.member_stress_rand(seed || ':' || l.ordinal::text || ':ud:rl:' || les.id) < 0.40)
    on conflict (lesson_id, user_id) do nothing;

    with topics as (
      select * from (values
        (0, 'What are my Weingarten rights?',
            'If a meeting could lead to discipline, you may request a steward before answering. Ask clearly and stop answering substantive questions until representation arrives.'),
        (1, 'How long do I have to file a grievance?',
            'A grievance must be filed within 21 calendar days of the event or of when you reasonably learned of it. Your steward tracks the deadlines with you.'),
        (2, 'Can they change my schedule without notice?',
            'Article 7 sets the posting and notice windows. Save the posted schedule and document when each change was delivered, then talk to your steward.'),
        (3, 'How does overtime equalization work?',
            'Article 8.3 requires rotation from the posted list. If you were skipped, the remedy is make-up hours — file it, do not absorb it.'),
        (4, 'What does just cause mean for discipline?',
            'Article 12 requires progressive discipline with proof. Signature on a notice confirms receipt only, never agreement.'),
        (5, 'How do I request telework?',
            'Article 15 sets the request and response windows. A denial must be in writing with a reason you can grieve.'),
        (6, 'What happens at a Step 2 hearing?',
            'The employer owes a written answer after the hearing. Bring your documentation; your steward presents the contract violations.'),
        (7, 'How do chapter ballots work?',
            'Ballots are chapter-scoped with a quorum target and a receipt code you can verify. Results publish after close.')
      ) v(idx, q, a)
    ),
    gthreads as (
      select t.ordinal, t.user_id, t.s, t.active_from, g.i,
        private.member_stress_uuid(t.s || ':ud:gt:' || g.i::text) as thread_id,
        private.member_stress_pick(t.s || ':ud:gtt:' || g.i::text, 8) as topic_idx,
        t.active_from + ((10 + private.member_stress_pick(t.s || ':ud:gtd:' || g.i::text,
          greatest(t.age_days - 12, 1))) || ' days')::interval as at
      from (
        select l.ordinal, l.user_id, l.steward, seed || ':' || l.ordinal::text as s,
          greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0) as active_from,
          (extract(epoch from (pg_catalog.now() - greatest(private.uniondemo_joined_at(p_run_id, l.ordinal, l.steward), t0))) / 86400)::integer as age_days
        from private.uniondemo_ledger l
        where l.run_id = p_run_id and l.ordinal between lo and hi
      ) t
      cross join lateral generate_series(1,
        case when t.steward then 2 + private.member_stress_pick(t.s || ':ud:gtn', 3)
             else 1 end) g(i)
      where t.steward or private.member_stress_rand(t.s || ':ud:hasgt') < 0.20
    ),
    thread_ins as (
      insert into public.member_guide_threads (id, user_id, title, created_at, updated_at)
      select g.thread_id, g.user_id, topics.q, g.at, g.at
      from gthreads g join topics on topics.idx = g.topic_idx
      on conflict (id) do nothing
      returning 1
    )
    insert into public.member_guide_messages (id, thread_id, user_id, role, body, created_at)
    select
      private.member_stress_uuid(g.s || ':ud:gm:' || g.i::text || ':' || m.n::text),
      g.thread_id, g.user_id, m.role,
      case when m.role = 'user' then topics.q else topics.a end,
      g.at + m.offs
    from gthreads g
    join topics on topics.idx = g.topic_idx
    cross join (values ('user', interval '0 seconds', 1), ('assistant', interval '8 seconds', 2)) m(role, offs, n)
    on conflict (id) do nothing;

  else
    raise exception 'unknown union demo enrichment phase %', p_phase;
  end if;

  return jsonb_build_object('phase', p_phase, 'from', lo, 'to', hi, 'touched', touched);
end;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.upsert_form_template(p_key text, p_label_en text, p_label_es text, p_blurb_en text, p_blurb_es text, p_icon text, p_points integer, p_sort smallint, p_active boolean, p_field_schema jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  template_org uuid := (select private.current_member_organization());
  next_version integer;
  new_row record;
begin
  if caller is null or template_org is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_key is null or p_key !~ '^[a-z][a-z0-9_]{2,49}$' then
    raise exception 'invalid key format' using errcode = '22023';
  end if;
  if pg_catalog.btrim(coalesce(p_label_en, '')) = '' or pg_catalog.btrim(coalesce(p_label_es, '')) = '' then
    raise exception 'label_en and label_es are required' using errcode = '22023';
  end if;
  if p_points is null or p_points < 0 or p_points > 100 then
    raise exception 'points must be 0-100' using errcode = '22023';
  end if;
  if p_icon is not null and pg_catalog.char_length(p_icon) > 8 then
    raise exception 'icon too long' using errcode = '22023';
  end if;
  perform private.validate_form_template_schema(p_field_schema);

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('form-template-' || p_key, 509));
  select coalesce(max(version), 0) + 1 into next_version from public.form_templates where key = p_key;

  update public.form_templates
    set active = false, updated_at = now(), updated_by = caller
    where key = p_key and organization_id = template_org and active = true;

  insert into public.form_templates
    (key, version, label_en, label_es, blurb_en, blurb_es, icon, points, active, sort, field_schema, updated_by, organization_id)
  values
    (p_key, next_version, pg_catalog.btrim(p_label_en), pg_catalog.btrim(p_label_es),
     nullif(pg_catalog.btrim(coalesce(p_blurb_en, '')), ''), nullif(pg_catalog.btrim(coalesce(p_blurb_es, '')), ''),
     nullif(pg_catalog.btrim(coalesce(p_icon, '')), ''), p_points, coalesce(p_active, true),
     coalesce(p_sort, 0::smallint), p_field_schema, caller, template_org)
  returning key, version, active into new_row;

  return pg_catalog.jsonb_build_object('key', new_row.key, 'version', new_row.version, 'active', new_row.active);
end;
end;
$function$;

-- Effective award trigger captured after the full replay; only the form branch
-- now passes the awarded form's pinned version.
CREATE OR REPLACE FUNCTION private.award_member_points()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  rule record;
  backed boolean := false;
  awarded_this_week integer;
  award_points integer;
  v_template text;
  v_version integer;
begin
  if new.action_kind = 'seed' then
    return new;
  end if;
  select points, weekly_cap into rule
  from public.member_point_rules
  where action_kind = new.action_kind and points > 0;
  if not found then
    return new;
  end if;
  award_points := rule.points;
  if new.action_kind = 'vote' then
    backed := pg_catalog.left(new.action_key, 5) = 'vote-' and exists (
      select 1 from public.member_ballot_receipts
      where user_id = new.user_id and ballot_id = pg_catalog.substr(new.action_key, 6));
  elsif new.action_kind = 'survey' then
    backed := pg_catalog.left(new.action_key, 7) = 'survey-' and exists (
      select 1 from public.member_survey_responses
      where user_id = new.user_id and survey_id = pg_catalog.substr(new.action_key, 8));
  elsif new.action_kind = 'rights' then
    backed := pg_catalog.left(new.action_key, 7) = 'rights-' and exists (
      select 1 from public.member_rights_progress
      where user_id = new.user_id and lesson_id = pg_catalog.substr(new.action_key, 8)
        and pg_catalog.cardinality(completed_steps) > 0);
  elsif new.action_kind = 'case' then
    backed := pg_catalog.left(new.action_key, 5) = 'case-' and exists (
      select 1 from public.member_cases
      where user_id = new.user_id and reference = pg_catalog.substr(new.action_key, 6));
  elsif new.action_kind = 'message' then
    -- Rebound: the key is the caller's OWN message row id. The sender_kind
    -- filter keeps steward replies and welcome seeds — which carry
    -- user_id = the member — from backing member-minted keys.
    backed := pg_catalog.left(new.action_key, 8) = 'message-' and exists (
      select 1 from public.member_messages
      where user_id = new.user_id and sender_kind = 'member'
        and id::text = pg_catalog.substr(new.action_key, 9));
  -- 'steward' pays at interaction time now (20260725230000): the
  -- acknowledgment trigger on member_steward_requests mints directly into
  -- member_point_events, so a member-minted steward key is never backed here.
  elsif new.action_kind = 'rsvp' then
    backed := pg_catalog.left(new.action_key, 5) = 'rsvp-' and exists (
      select 1 from public.member_event_rsvps
      where user_id = new.user_id and event_id = pg_catalog.substr(new.action_key, 6));
  elsif new.action_kind = 'checkin' then
    backed := pg_catalog.left(new.action_key, 8) = 'checkin-' and exists (
      select 1 from public.member_event_checkins
      where user_id = new.user_id and event_id = pg_catalog.substr(new.action_key, 9));
  elsif new.action_kind = 'workload' then
    backed := pg_catalog.left(new.action_key, 9) = 'workload-' and exists (
      select 1 from public.member_workload_logs
      where user_id = new.user_id and id::text = pg_catalog.substr(new.action_key, 10));
  elsif new.action_kind = 'form' then
    if pg_catalog.left(new.action_key, 5) = 'form-' then
      select template_key, template_version into v_template, v_version from public.member_forms
      where user_id = new.user_id and id::text = pg_catalog.substr(new.action_key, 6)
        and status <> 'draft';
      if found then
        backed := true;
        award_points := private.form_points(v_template, v_version);
      end if;
    end if;
  elsif new.action_kind = 'scan' then
    if pg_catalog.left(new.action_key, 5) = 'scan-'
      and pg_catalog.substr(new.action_key, 6, 36) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and pg_catalog.substr(new.action_key, 42, 1) = '-' then
      backed := exists (
        select 1 from public.member_event_checkins
        where scanned_by = new.user_id
          and user_id = (pg_catalog.substr(new.action_key, 6, 36))::uuid
          and event_id = pg_catalog.substr(new.action_key, 43));
    end if;
  end if;
  if not backed then
    return new;
  end if;
  if rule.weekly_cap is not null then
    select count(*) into awarded_this_week
    from public.member_point_events
    where user_id = new.user_id and action_kind = new.action_kind
      and occurred_at >= pg_catalog.date_trunc('week', now());
    if awarded_this_week >= rule.weekly_cap then
      return new;
    end if;
  end if;
  insert into public.member_point_events (user_id, action_key, action_kind, points)
  values (new.user_id, new.action_key, new.action_kind, award_points)
  on conflict (user_id, action_key) do nothing;
  return new;
end;
end;
$function$;

-- The points helpers and the award trigger are reachable from retained
-- form/award triggers. Register only their reviewed changed bodies; every
-- other inventory entry stays pinned.
insert into private.account_lifecycle_trigger_review
  (kind,schema_name,table_name,object_name,definition_hash)
select kind,schema_name,table_name,object_name,definition_hash
from private.account_lifecycle_trigger_surface()
where kind='function' and schema_name='private'
  and object_name in ('form_points(p_template_key text)',
    'form_points(p_template_key text, p_template_version integer)','award_member_points()')
on conflict (kind,schema_name,table_name,object_name)
do update set definition_hash=excluded.definition_hash;

notify pgrst, 'reload schema';

commit;
