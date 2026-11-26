-- MI1 CR-053..CR-067: cursor paging plus reversible SAMPLE seed depth.
-- Sequenced after the coordination decision and public-microsite migration.
--
-- The product origin remains empty. These hooks run only inside the existing
-- service-role-only SAMPLE seed RPCs, after their project-ref and confirmation
-- token checks. Both demo lanes receive the same backed coordination behavior
-- while retaining independent run ledgers and symmetric teardown.

set local lock_timeout = '5s';

create function public.list_organization_coordination_records(
  p_before_updated_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  page_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  staff boolean;
  payload jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
     or not private.is_organization_member(organization) then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  if (p_before_updated_at is null) <> (p_before_id is null) then
    raise exception 'complete coordination cursor required' using errcode = '22023';
  end if;
  staff := private.organization_coordination_is_staff(organization);

  with candidates as materialized (
    select record.*
    from public.organization_coordination_records record
    where private.organization_coordination_can_read(record.id)
      and (
        p_before_updated_at is null
        or (record.updated_at, record.id) < (p_before_updated_at, p_before_id)
      )
    order by record.updated_at desc, record.id desc
    limit page_limit + 1
  ), page as (
    select * from candidates
    order by updated_at desc, id desc
    limit page_limit
  )
  select pg_catalog.jsonb_build_object(
    'records', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', record.id, 'kind', record.kind,
        'title', record.title, 'summary', record.summary,
        'status', record.status, 'visibility', record.visibility,
        'organizationId', record.organization_id,
        'partnerOrganizationId', record.partner_organization_id,
        'chapterId', record.chapter_id, 'parentId', record.parent_id,
        'config', case when staff or record.visibility <> 'staff'
          then record.config else '{}'::jsonb end,
        'createdAt', record.created_at, 'updatedAt', record.updated_at
      ) order by record.updated_at desc, record.id desc)
      from page record
    ), '[]'::jsonb),
    'nextCursor', case when (select pg_catalog.count(*) from candidates) > page_limit
      then (select pg_catalog.jsonb_build_object(
        'updatedAt', record.updated_at, 'id', record.id
      ) from page record order by record.updated_at, record.id limit 1)
      else null end
  ) into payload;

  return payload;
end;
$function$;

revoke all on function public.list_organization_coordination_records(
  timestamptz, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.list_organization_coordination_records(
  timestamptz, uuid, integer
) to authenticated;

create table private.demo_seed_coordination_runs (
  lane text not null check (lane in ('presg', 'uniondemo')),
  run_id uuid not null,
  organization_id uuid not null,
  partner_organization_id uuid not null,
  chapter_id text not null,
  actor_user_id uuid not null,
  section_prefix text not null,
  public_record_created boolean not null,
  seeded_at timestamptz not null default pg_catalog.now(),
  primary key (lane, run_id)
);

revoke all on private.demo_seed_coordination_runs
  from public, anon, authenticated, service_role;

update private.demo_seed_function_catalog
set coverage = 'seeded',
    evidence_key = case function_id
      when 'CR-053' then 'coordination-missions'
      when 'CR-054' then 'coordination-badges'
      when 'CR-055' then 'coordination-directory'
      when 'CR-056' then 'coordination-messages'
      when 'CR-057' then 'coordination-resources'
      when 'CR-058' then 'coordination-permissions'
      when 'CR-059' then 'coordination-exports'
      when 'CR-060' then 'coordination-handshakes'
      when 'CR-061' then 'coordination-coalitions'
      when 'CR-062' then 'coordination-coalition-decisions'
      when 'CR-063' then 'coordination-mergers'
      when 'CR-064' then 'coordination-public-microsites'
      when 'CR-065' then 'coordination-coverage'
      when 'CR-066' then 'coordination-committees'
      when 'CR-067' then 'coordination-mobilization'
    end,
    gate_relation = null
where function_id between 'CR-053' and 'CR-067';

insert into private.demo_seed_page_contract
  (surface, page_size, minimum_rows, scope, source)
values
  ('organizationCoordination', 50, 100, 'organization',
    'supabase/migrations/20260828234000_mi1_coordination_pagination_demo_seed.sql'),
  ('organizationCoordinationMessages', 30, 60, 'organization',
    'supabase/migrations/20260828235000_mi1_organization_coordination_hardening.sql'),
  ('publicChapterMicrositePages', 24, 48, 'chapter',
    'supabase/migrations/20260828234000_mi1_coordination_pagination_demo_seed.sql')
on conflict (surface) do update set
  page_size = excluded.page_size,
  minimum_rows = excluded.minimum_rows,
  scope = excluded.scope,
  source = excluded.source;

create function private.demo_seed_apply_organization_coordination(
  p_lane text,
  p_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '300s'
as $function$
<<seed_coordination>>
declare
  organization uuid;
  partner uuid := private.member_stress_uuid('coordination:partner:' || p_lane);
  actor uuid;
  chapter text;
  current_record_id uuid;
  current_parent_id uuid;
  current_campaign_id uuid;
  current_work_id uuid;
  current_decision_id uuid;
  prefix text := 'coord-' || pg_catalog.substr(
    pg_catalog.md5(p_run_id::text || ':' || p_lane), 1, 8
  );
  created_public_record boolean;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  if p_lane = 'presg' then
    organization := private.member_stress_uuid(p_run_id::text || ':presg:organization');
  elsif p_lane = 'uniondemo' then
    organization := private.member_stress_uuid(p_run_id::text || ':ud:organization');
  else
    raise exception 'unknown demo lane';
  end if;
  actor := private.demo_seed_user(p_lane, p_run_id, 1);
  chapter := private.demo_seed_chapter(p_lane, p_run_id, 1);
  if not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = organization
      and membership.user_id = actor and membership.status = 'active'
  ) then
    raise exception 'demo coordination actor is not an active organization member';
  end if;

  insert into public.organizations (id, slug, name, status)
  values (
    partner,
    case when p_lane = 'presg' then 'harbor-service-network'
      else 'pioneer-valley-workers-council' end,
    case when p_lane = 'presg' then 'Harbor Service Workers Network'
      else 'Pioneer Valley Public Workers Council' end,
    'active'
  ) on conflict (id) do update set status = 'active', updated_at = pg_catalog.now();

  insert into public.organization_network_directory_profiles (
    organization_id, display_name, summary, visibility, contact_mode, updated_by
  ) values (
    partner,
    case when p_lane = 'presg' then 'Harbor Service Workers Network'
      else 'Pioneer Valley Public Workers Council' end,
    'A neighboring worker organization coordinating training, resources, and public actions.',
    'directory', 'coordinator_routed', null
  ) on conflict (organization_id) do update set
    visibility = 'directory', contact_mode = 'coordinator_routed',
    updated_at = pg_catalog.now();

  created_public_record := not exists (
    select 1 from public.public_site_records record where record.id = chapter
  );
  insert into public.public_site_records (
    id, kind, title_en, title_es, body_en, body_es,
    region_en, region_es, sort_order, is_published, published_at,
    created_by, organization_id, chapter_code
  )
  select chapter, 'chapter', chapter_row.name, chapter_row.name,
    'Member resources, meeting information, and chapter updates.',
    'Recursos para miembros, información de reuniones y novedades del capítulo.',
    coalesce(chapter_row.region, 'Statewide'),
    coalesce(chapter_row.region, 'Statewide'),
    chapter_row.order_index, true, pg_catalog.now(), actor, organization, chapter
  from public.chapters chapter_row where chapter_row.id = chapter
  on conflict (id) do update set
    organization_id = excluded.organization_id,
    chapter_code = excluded.chapter_code,
    is_published = true,
    published_at = coalesce(public.public_site_records.published_at, excluded.published_at),
    updated_at = pg_catalog.now();

  insert into private.demo_seed_coordination_runs (
    lane, run_id, organization_id, partner_organization_id, chapter_id,
    actor_user_id, section_prefix, public_record_created
  ) values (
    p_lane, p_run_id, organization, partner, chapter,
    actor, prefix, created_public_record
  ) on conflict (lane, run_id) do update set
    organization_id = excluded.organization_id,
    partner_organization_id = excluded.partner_organization_id,
    chapter_id = excluded.chapter_id,
    actor_user_id = excluded.actor_user_id,
    section_prefix = excluded.section_prefix;

  -- Missions and objectives: enough distinct, completed and active work to
  -- exercise cards, member joins, badges, and anonymized leaderboard order.
  for i in 1..12 loop
    current_record_id := private.member_stress_uuid(p_run_id::text || ':coord:mission:' || i);
    insert into public.organization_coordination_records (
      id, organization_id, kind, title, summary, status, visibility,
      config, created_by, idempotency_key, created_at, updated_at
    ) values (
      current_record_id, organization, 'mission',
      (array['Weekend outreach sprint','Safety story collection','Meeting turnout drive'])[1 + (i % 3)] || ' ' || i,
      'A realistic shared mission with bounded objectives and participant progress.',
      case when i % 4 = 0 then 'completed' else 'active' end, 'members',
      pg_catalog.jsonb_build_object('demoRunId', p_run_id, 'sequence', i),
      actor, private.member_stress_uuid(p_run_id::text || ':coord:mission-key:' || i),
      pg_catalog.now() - (i || ' days')::interval,
      pg_catalog.now() - (i || ' hours')::interval
    ) on conflict (id) do nothing;
    insert into public.organization_coordination_user_participants (
      record_id, organization_id, user_id, role, status, points, privacy_alias, config
    ) select current_record_id, organization, seeded.user_id,
      case when ordinal = 1 then 'captain' else 'participant' end,
      case when i % 4 = 0 then 'completed' else 'active' end,
      20 + ordinal * 15 + i,
      'Member ' || pg_catalog.upper(pg_catalog.substr(pg_catalog.md5(seeded.user_id::text), 1, 6)),
      pg_catalog.jsonb_build_object('demoRunId', p_run_id)
    from (
      select ordinal, private.demo_seed_user(p_lane, p_run_id, i * 6 + ordinal) user_id
      from pg_catalog.generate_series(1, 6) ordinal
    ) seeded
    on conflict (record_id, organization_id, user_id) do nothing;
    insert into public.organization_mission_badges (
      mission_id, organization_id, user_id, privacy_alias, badge_key
    ) select participant.record_id, participant.organization_id,
      participant.user_id, participant.privacy_alias,
      case when participant.points >= 100 then 'silver' else 'bronze' end
    from public.organization_coordination_user_participants participant
    where participant.record_id = current_record_id
    on conflict do nothing;

    current_parent_id := current_record_id;
    insert into public.organization_coordination_records (
      id, organization_id, parent_id, kind, title, summary, status,
      visibility, config, created_by, idempotency_key, created_at, updated_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':coord:objective:' || i),
      organization, current_parent_id, 'mission_objective',
      'Complete assigned conversations ' || i,
      'Reach the next bounded milestone and record only the outcome.',
      case when i % 3 = 0 then 'completed' else 'active' end, 'members',
      pg_catalog.jsonb_build_object('demoRunId', p_run_id, 'points', 15),
      actor, private.member_stress_uuid(p_run_id::text || ':coord:objective-key:' || i),
      pg_catalog.now() - (i || ' days')::interval,
      pg_catalog.now() - ((i + 1) || ' hours')::interval
    ) on conflict (id) do nothing;
  end loop;

  -- Each active network has explicit reciprocal participants and capability
  -- grants before its conversation/request children are inserted.
  for i in 1..10 loop
    current_parent_id := private.member_stress_uuid(p_run_id::text || ':coord:network:' || i);
    insert into public.organization_coordination_records (
      id, organization_id, partner_organization_id, kind, title, summary,
      status, visibility, config, created_by, idempotency_key, created_at, updated_at
    ) values (
      current_parent_id, organization, partner, 'network_link',
      'Regional coordination channel ' || i,
      'An explicit partner connection for messages and bounded resource exchange.',
      'active', 'participants',
      pg_catalog.jsonb_build_object('demoRunId', p_run_id, 'sequence', i),
      actor, private.member_stress_uuid(p_run_id::text || ':coord:network-key:' || i),
      pg_catalog.now() - (i || ' days')::interval,
      pg_catalog.now() - ((20 + i) || ' minutes')::interval
    ) on conflict (id) do nothing;
    insert into public.organization_coordination_organization_participants (
      record_id, organization_id, role, status, invited_by, responded_by
    ) values
      (current_parent_id, organization, 'owner', 'active', actor, actor),
      (current_parent_id, partner, 'partner', 'active', actor, actor)
    on conflict (record_id, organization_id) do update set status = 'active';
    insert into public.organization_network_permission_grants (
      network_record_id, grantor_organization_id, grantee_organization_id,
      capability, status, granted_by
    ) select current_parent_id, organization, partner, capability, 'active', actor
    from unnest(array['directory_contact','message','resource_request','resource_share']) capability
    on conflict (network_record_id, grantor_organization_id, grantee_organization_id, capability)
    do update set status = 'active', revoked_at = null;

    current_record_id := private.member_stress_uuid(p_run_id::text || ':coord:conversation:' || i);
    insert into public.organization_coordination_records (
      id, organization_id, partner_organization_id, parent_id, kind,
      title, summary, status, visibility, config, created_by,
      idempotency_key, created_at, updated_at
    ) values (
      current_record_id, organization, partner, current_parent_id, 'network_conversation',
      'Partner planning thread ' || i,
      'Authorized staff coordinate the next shared step.', 'active', 'participants',
      pg_catalog.jsonb_build_object('demoRunId', p_run_id), actor,
      private.member_stress_uuid(p_run_id::text || ':coord:conversation-key:' || i),
      pg_catalog.now() - (i || ' days')::interval,
      pg_catalog.now() - ((30 + i) || ' minutes')::interval
    ) on conflict (id) do nothing;
    insert into public.organization_coordination_messages (
      id, conversation_id, sender_organization_id, sender_user_id,
      body, idempotency_key, created_at
    ) select private.member_stress_uuid(p_run_id::text || ':coord:message:' || i || ':' || message_number),
      current_record_id, case when message_number % 2 = 0 then partner else organization end,
      case when message_number % 2 = 0 then null else actor end,
      (array['Training materials are ready for review.','The shared meeting window is confirmed.','Please route questions through the named coordinators.'])[1 + (message_number % 3)],
      private.member_stress_uuid(p_run_id::text || ':coord:message-key:' || i || ':' || message_number),
      pg_catalog.now() - ((i * 20 + message_number) || ' minutes')::interval
    from pg_catalog.generate_series(1, 6) message_number
    on conflict (id) do nothing;

    current_record_id := private.member_stress_uuid(p_run_id::text || ':coord:request:' || i);
    insert into public.organization_coordination_records (
      id, organization_id, partner_organization_id, parent_id, kind,
      title, summary, status, visibility, config, created_by,
      idempotency_key, created_at, updated_at
    ) values (
      current_record_id, organization, partner, current_parent_id, 'network_request',
      'Request training resource ' || i,
      'A bounded request that links authorized material without copying member data.',
      'requested', 'participants',
      pg_catalog.jsonb_build_object('demoRunId', p_run_id), actor,
      private.member_stress_uuid(p_run_id::text || ':coord:request-key:' || i),
      pg_catalog.now() - (i || ' days')::interval,
      pg_catalog.now() - ((40 + i) || ' minutes')::interval
    ) on conflict (id) do nothing;
    insert into public.organization_coordination_resources (
      id, record_id, from_organization_id, to_organization_id,
      resource_kind, title, status, idempotency_key, created_by, created_at, updated_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':coord:resource:' || i),
      current_record_id, organization, partner, 'request',
      'Facilitation guide request ' || i,
      case when i % 3 = 0 then 'accepted' else 'requested' end,
      private.member_stress_uuid(p_run_id::text || ':coord:resource-key:' || i),
      actor, pg_catalog.now() - (i || ' days')::interval,
      pg_catalog.now() - ((50 + i) || ' minutes')::interval
    ) on conflict (id) do nothing;
  end loop;

  for i in 1..8 loop
    current_record_id := private.member_stress_uuid(p_run_id::text || ':coord:export:' || i);
    insert into public.organization_coordination_records (
      id, organization_id, kind, title, summary, status, visibility,
      config, created_by, idempotency_key, created_at, updated_at
    ) values (
      current_record_id, organization, 'network_export_schedule',
      'Authorized network export ' || i,
      'Internal download schedule; external delivery remains explicitly unset.',
      'active', 'staff',
      pg_catalog.jsonb_build_object(
        'demoRunId', p_run_id, 'cadence', case when i % 2 = 0 then 'monthly' else 'weekly' end,
        'format', case when i % 2 = 0 then 'json' else 'csv' end,
        'deliveryMode', 'internal_download',
        'nextRunAt', (pg_catalog.now() + (i || ' days')::interval)::text
      ), actor, private.member_stress_uuid(p_run_id::text || ':coord:export-key:' || i),
      pg_catalog.now() - (i || ' days')::interval,
      pg_catalog.now() - ((60 + i) || ' minutes')::interval
    ) on conflict (id) do nothing;
    insert into public.organization_coordination_export_runs (
      id, schedule_id, organization_id, requested_by, format,
      delivery_mode, status, row_count, expires_at, idempotency_key, created_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':coord:export-run:' || i),
      current_record_id, organization, actor,
      case when i % 2 = 0 then 'json' else 'csv' end,
      'internal_download', 'ready', 120 + i,
      pg_catalog.now() + interval '24 hours',
      private.member_stress_uuid(p_run_id::text || ':coord:export-run-key:' || i),
      pg_catalog.now() - (i || ' hours')::interval
    ) on conflict (id) do nothing;

    insert into public.organization_coordination_records (
      id, organization_id, chapter_id, kind, title, summary, status,
      visibility, config, created_by, idempotency_key, created_at, updated_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':coord:handshake:' || i),
      organization, chapter, 'handshake_workspace_item',
      'Chapter handshake step ' || i,
      'Reciprocal chapter coordination with an explicit lifecycle checkpoint.',
      (array['requested','active','completed'])[1 + (i % 3)], 'staff',
      pg_catalog.jsonb_build_object('demoRunId', p_run_id, 'stage', (array['request','reciprocal-review','shared-work'])[1 + (i % 3)]),
      actor, private.member_stress_uuid(p_run_id::text || ':coord:handshake-key:' || i),
      pg_catalog.now() - (i || ' days')::interval,
      pg_catalog.now() - ((70 + i) || ' minutes')::interval
    ) on conflict (id) do nothing;
  end loop;

  for i in 1..8 loop
    current_parent_id := private.member_stress_uuid(p_run_id::text || ':coord:coalition:' || i);
    insert into public.organization_coordination_records (
      id, organization_id, partner_organization_id, kind, title, summary,
      status, visibility, config, created_by, idempotency_key, created_at, updated_at
    ) values (
      current_parent_id, organization, partner, 'coalition',
      'Public service coalition ' || i,
      'A governed coalition with two active organizations and recorded approvals.',
      'active', 'participants', pg_catalog.jsonb_build_object('demoRunId', p_run_id),
      actor, private.member_stress_uuid(p_run_id::text || ':coord:coalition-key:' || i),
      pg_catalog.now() - (i || ' days')::interval,
      pg_catalog.now() - ((80 + i) || ' minutes')::interval
    ) on conflict (id) do nothing;
    insert into public.organization_coordination_organization_participants (
      record_id, organization_id, role, status, invited_by, responded_by
    ) values
      (current_parent_id, organization, 'owner', 'active', actor, actor),
      (current_parent_id, partner, 'approver', 'active', actor, actor)
    on conflict (record_id, organization_id) do update set status = 'active';
    current_campaign_id := private.member_stress_uuid(p_run_id::text || ':coord:coalition-campaign:' || i);
    insert into public.organization_coordination_records (
      id, organization_id, partner_organization_id, parent_id, kind,
      title, summary, status, visibility, config, created_by,
      idempotency_key, created_at, updated_at
    ) values (
      current_campaign_id, organization, partner, current_parent_id, 'coalition_campaign',
      'Joint action campaign ' || i,
      'Shared execution stays gated by explicit organization approvals.',
      'active', 'participants', pg_catalog.jsonb_build_object('demoRunId', p_run_id),
      actor, private.member_stress_uuid(p_run_id::text || ':coord:coalition-campaign-key:' || i),
      pg_catalog.now() - (i || ' days')::interval,
      pg_catalog.now() - ((90 + i) || ' minutes')::interval
    ) on conflict (id) do nothing;
    current_work_id := private.member_stress_uuid(p_run_id::text || ':coord:coalition-work:' || i);
    insert into public.organization_coordination_records (
      id, organization_id, partner_organization_id, parent_id, kind,
      title, summary, status, visibility, config, created_by,
      idempotency_key, created_at, updated_at
    ) values (
      current_work_id, organization, partner, current_campaign_id, 'coalition_work_item',
      'Joint field assignment ' || i,
      'A campaign work item controlled by the coalition decision record.',
      case when i % 3 = 0 then 'active' else 'draft' end,
      'participants', pg_catalog.jsonb_build_object('demoRunId', p_run_id),
      actor, private.member_stress_uuid(p_run_id::text || ':coord:coalition-work-key:' || i),
      pg_catalog.now() - (i || ' days')::interval,
      pg_catalog.now() - ((100 + i) || ' minutes')::interval
    ) on conflict (id) do nothing;
    current_decision_id := private.member_stress_uuid(p_run_id::text || ':coord:decision:' || i);
    insert into public.organization_coalition_decisions (
      id, campaign_id, subject_record_id, proposing_organization_id,
      title, rationale, action, status, required_approvals, proposed_by,
      resolved_at, idempotency_key, created_at, updated_at
    ) values (
      current_decision_id, current_campaign_id, current_work_id, organization,
      'Authorize joint assignment ' || i,
      'Both participating organizations review scope and responsibility before work starts.',
      'authorize_work', case when i % 3 = 0 then 'approved' else 'open' end,
      2, actor, case when i % 3 = 0 then pg_catalog.now() - interval '1 hour' else null end,
      private.member_stress_uuid(p_run_id::text || ':coord:decision-key:' || i),
      pg_catalog.now() - (i || ' days')::interval,
      pg_catalog.now() - ((110 + i) || ' minutes')::interval
    ) on conflict (id) do nothing;
    insert into public.organization_coalition_decision_votes (
      decision_id, organization_id, voter_user_id, vote, comment,
      idempotency_key, created_at, updated_at
    ) values (
      current_decision_id, organization, actor, 'approve',
      'Scope and responsibilities reviewed.',
      private.member_stress_uuid(p_run_id::text || ':coord:decision-vote-key:' || i),
      pg_catalog.now() - (i || ' hours')::interval,
      pg_catalog.now() - (i || ' hours')::interval
    ) on conflict (decision_id, organization_id) do nothing;
    if i % 3 = 0 then
      insert into public.organization_coalition_decision_votes (
        decision_id, organization_id, voter_user_id, vote, comment,
        idempotency_key, created_at, updated_at
      ) values (
        current_decision_id, partner, null, 'approve',
        'Partner organization approval recorded by its authorized representative.',
        private.member_stress_uuid(p_run_id::text || ':coord:decision-partner-vote-key:' || i),
        pg_catalog.now() - (i || ' hours')::interval,
        pg_catalog.now() - (i || ' hours')::interval
      ) on conflict (decision_id, organization_id) do nothing;
    end if;
  end loop;

  for i in 1..4 loop
    current_record_id := private.member_stress_uuid(p_run_id::text || ':coord:merger:' || i);
    insert into public.organization_coordination_records (
      id, organization_id, partner_organization_id, kind, title, summary,
      status, visibility, config, created_by, idempotency_key, created_at, updated_at
    ) values (
      current_record_id, organization, partner, 'merger_plan',
      'Organization consolidation plan ' || i,
      'A reversible mapping review with operator execution kept explicit.',
      'pending_operator', 'staff', pg_catalog.jsonb_build_object('demoRunId', p_run_id),
      actor, private.member_stress_uuid(p_run_id::text || ':coord:merger-key:' || i),
      pg_catalog.now() - (i || ' days')::interval,
      pg_catalog.now() - ((120 + i) || ' minutes')::interval
    ) on conflict (id) do nothing;
    insert into public.organization_merge_match_reviews (
      plan_id, source_user_id, target_user_id, decision, created_at
    ) values (
      current_record_id, private.demo_seed_user(p_lane, p_run_id, i + 10),
      private.demo_seed_user(p_lane, p_run_id, i + 20), 'pending',
      pg_catalog.now() - (i || ' days')::interval
    ) on conflict (plan_id, source_user_id, target_user_id) do nothing;
    insert into public.organization_merge_jobs (
      id, plan_id, source_organization_id, target_organization_id,
      status, requested_by, approved_match_count, requested_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':coord:merger-job:' || i),
      current_record_id, partner, organization, 'queued', actor, 0,
      pg_catalog.now() - (i || ' hours')::interval
    ) on conflict (plan_id) do nothing;
  end loop;

  for i in 1..8 loop
    insert into public.organization_coordination_records (
      id, organization_id, chapter_id, kind, title, summary, status,
      visibility, config, created_by, idempotency_key, created_at, updated_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':coord:coverage:' || i),
      organization, chapter, 'coverage_schedule',
      'Steward coverage window ' || i,
      'A recurring chapter coverage window with a selected active steward.',
      'active', 'staff', pg_catalog.jsonb_build_object(
        'demoRunId', p_run_id, 'stewardUserId', actor,
        'dayOfWeek', i % 7, 'startMinute', 540, 'endMinute', 1020,
        'timezone', 'America/New_York'
      ), actor, private.member_stress_uuid(p_run_id::text || ':coord:coverage-key:' || i),
      pg_catalog.now() - (i || ' days')::interval,
      pg_catalog.now() - ((130 + i) || ' minutes')::interval
    ) on conflict (id) do nothing;
    insert into public.organization_coordination_records (
      id, organization_id, chapter_id, kind, title, summary, status,
      visibility, config, created_by, idempotency_key, created_at, updated_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':coord:coverage-override:' || i),
      organization, chapter, 'coverage_override',
      'Coverage exception ' || i,
      'A dated availability exception that never overwrites the recurring schedule.',
      'active', 'staff', pg_catalog.jsonb_build_object(
        'demoRunId', p_run_id, 'stewardUserId', actor,
        'startsAt', (pg_catalog.now() + (i || ' days')::interval)::text,
        'endsAt', (pg_catalog.now() + (i || ' days')::interval + interval '4 hours')::text,
        'available', i % 2 = 0
      ), actor, private.member_stress_uuid(p_run_id::text || ':coord:coverage-override-key:' || i),
      pg_catalog.now() - (i || ' days')::interval,
      pg_catalog.now() - ((140 + i) || ' minutes')::interval
    ) on conflict (id) do nothing;
    current_record_id := private.member_stress_uuid(p_run_id::text || ':coord:committee:' || i);
    insert into public.organization_coordination_records (
      id, organization_id, chapter_id, kind, title, summary, status,
      visibility, config, created_by, idempotency_key, created_at, updated_at
    ) values (
      current_record_id, organization, chapter, 'committee',
      (array['Health and safety committee','Political education committee','New member committee'])[1 + (i % 3)] || ' ' || i,
      'A chapter committee with explicit member selections and role history.',
      'active', 'members', pg_catalog.jsonb_build_object('demoRunId', p_run_id),
      actor, private.member_stress_uuid(p_run_id::text || ':coord:committee-key:' || i),
      pg_catalog.now() - (i || ' days')::interval,
      pg_catalog.now() - ((150 + i) || ' minutes')::interval
    ) on conflict (id) do nothing;
    insert into public.organization_coordination_user_participants (
      record_id, organization_id, user_id, role, status, points,
      privacy_alias, config
    ) values (
      current_record_id, organization, private.demo_seed_user(p_lane, p_run_id, i + 30),
      'committee_member', 'active', 0,
      'Member ' || pg_catalog.upper(pg_catalog.substr(pg_catalog.md5(i::text || p_run_id::text), 1, 6)),
      pg_catalog.jsonb_build_object('demoRunId', p_run_id, 'selectedBy', actor)
    ) on conflict (record_id, organization_id, user_id) do nothing;
  end loop;

  for i in 1..6 loop
    insert into public.organization_coordination_records (
      id, organization_id, chapter_id, kind, title, summary, status,
      visibility, config, created_by, idempotency_key, created_at, updated_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':coord:microsite:' || i),
      organization, chapter, 'microsite_page',
      'Chapter information page ' || i,
      'A backed chapter page draft mirrored by the public hierarchy editor.',
      'active', 'public', pg_catalog.jsonb_build_object(
        'demoRunId', p_run_id, 'sectionSlug', prefix || '-section',
        'pageSlug', 'chapter-page-' || i
      ), actor, private.member_stress_uuid(p_run_id::text || ':coord:microsite-key:' || i),
      pg_catalog.now() - (i || ' days')::interval,
      pg_catalog.now() - ((160 + i) || ' minutes')::interval
    ) on conflict (id) do nothing;
  end loop;

  for i in 1..10 loop
    current_parent_id := private.member_stress_uuid(p_run_id::text || ':coord:mobilization:' || i);
    insert into public.organization_coordination_records (
      id, organization_id, kind, title, summary, status, visibility,
      config, created_by, idempotency_key, created_at, updated_at
    ) values (
      current_parent_id, organization, 'mobilization_campaign',
      (array['Meeting turnout','Member-to-member outreach','Community action'])[1 + (i % 3)] || ' ' || i,
      'A finite outreach campaign with disposition history and visible progress.',
      case when i % 4 = 0 then 'paused' else 'active' end, 'staff',
      pg_catalog.jsonb_build_object('demoRunId', p_run_id), actor,
      private.member_stress_uuid(p_run_id::text || ':coord:mobilization-key:' || i),
      pg_catalog.now() - (i || ' days')::interval,
      pg_catalog.now() - ((170 + i) || ' minutes')::interval
    ) on conflict (id) do nothing;
    insert into public.organization_coordination_records (
      id, organization_id, parent_id, kind, title, summary, status,
      visibility, config, created_by, idempotency_key, created_at, updated_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':coord:cohort:' || i),
      organization, current_parent_id, 'mobilization_cohort',
      'Outreach cohort ' || i,
      'A bounded member cohort assigned to the campaign.', 'active', 'staff',
      pg_catalog.jsonb_build_object('demoRunId', p_run_id, 'sequence', i), actor,
      private.member_stress_uuid(p_run_id::text || ':coord:cohort-key:' || i),
      pg_catalog.now() - (i || ' days')::interval,
      pg_catalog.now() - ((180 + i) || ' minutes')::interval
    ) on conflict (id) do nothing;
    insert into public.organization_coordination_outreach_events (
      id, campaign_id, organization_id, target_user_id, actor_user_id,
      disposition, note, idempotency_key, contacted_at
    ) select private.member_stress_uuid(p_run_id::text || ':coord:outreach:' || i || ':' || outreach_number),
      current_parent_id, organization,
      private.demo_seed_user(p_lane, p_run_id, i * 5 + outreach_number), actor,
      (array['attempted','reached','follow_up','committed','attended'])[1 + (outreach_number % 5)],
      case when outreach_number % 3 = 0 then 'Follow-up requested after the conversation.' else '' end,
      private.member_stress_uuid(p_run_id::text || ':coord:outreach-key:' || i || ':' || outreach_number),
      pg_catalog.now() - ((i * 10 + outreach_number) || ' hours')::interval
    from pg_catalog.generate_series(1, 10) outreach_number
    on conflict (id) do nothing;
  end loop;

  -- Two complete 24-page slices on the actual public chapter hierarchy.
  for i in 1..2 loop
    insert into public.public_chapter_sections (
      organization_id, chapter_code, slug, title_en, title_es,
      body_en, body_es, sort_order, is_published, published_at, created_by
    ) values (
      organization, chapter, prefix || '-section-' || i,
      case when i = 1 then 'Member resources' else 'Chapter participation' end,
      case when i = 1 then 'Recursos para miembros' else 'Participación del capítulo' end,
      'Practical information and current chapter resources.',
      'Información práctica y recursos actuales del capítulo.',
      80 + i, true, pg_catalog.now(), actor
    ) on conflict (organization_id, chapter_code, slug) do update set
      is_published = true,
      published_at = coalesce(public.public_chapter_sections.published_at, excluded.published_at),
      updated_at = pg_catalog.now();
    insert into public.public_chapter_pages (
      organization_id, chapter_code, section_slug, slug,
      title_en, title_es, body_en, body_es, sort_order,
      is_published, published_at, created_by
    ) select organization, chapter, prefix || '-section-' || i,
      'resource-' || pg_catalog.lpad(page_number::text, 2, '0'),
      'Chapter resource ' || page_number,
      'Recurso del capítulo ' || page_number,
      'A concise fictional resource page with current contacts, steps, and meeting information.',
      'Una página ficticia y concisa con contactos, pasos e información de reuniones.',
      page_number, true, pg_catalog.now(), actor
    from pg_catalog.generate_series(1, 24) page_number
    on conflict (organization_id, chapter_code, section_slug, slug) do update set
      is_published = true,
      updated_at = pg_catalog.now();
  end loop;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'records', (select pg_catalog.count(*)
      from public.organization_coordination_records record
      where record.organization_id = organization
        and record.config ->> 'demoRunId' = p_run_id::text),
    'publicPages', (select pg_catalog.count(*)
      from public.public_chapter_pages page
      where page.organization_id = organization and page.chapter_code = chapter
        and page.section_slug like prefix || '%'),
    'outboundDeliveries', 0
  );
end;
$function$;

create function private.demo_seed_remove_organization_coordination(
  p_lane text,
  p_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  seeded private.demo_seed_coordination_runs%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  select * into seeded from private.demo_seed_coordination_runs
  where lane = p_lane and run_id = p_run_id;
  if not found then
    return pg_catalog.jsonb_build_object('removed', true, 'records', 0);
  end if;

  delete from public.public_chapter_sections section
  where section.organization_id = seeded.organization_id
    and section.chapter_code = seeded.chapter_id
    and section.slug like seeded.section_prefix || '%';
  delete from public.organization_merge_jobs job
  using public.organization_coordination_records record
  where job.plan_id = record.id
    and record.config ->> 'demoRunId' = p_run_id::text;
  delete from public.organization_merge_remap_events event
  using public.organization_coordination_records record
  where event.plan_id = record.id
    and record.config ->> 'demoRunId' = p_run_id::text;
  delete from public.organization_coordination_records record
  where record.config ->> 'demoRunId' = p_run_id::text;
  if seeded.public_record_created then
    delete from public.public_site_records record
    where record.id = seeded.chapter_id
      and record.organization_id = seeded.organization_id;
  end if;
  delete from private.demo_seed_coordination_runs
  where lane = p_lane and run_id = p_run_id;
  if not exists (
    select 1 from private.demo_seed_coordination_runs run
    where run.partner_organization_id = seeded.partner_organization_id
  ) then
    delete from public.organization_network_access_events event
    where event.actor_organization_id = seeded.partner_organization_id
      or event.subject_organization_id = seeded.partner_organization_id;
    delete from public.organization_network_directory_profiles profile
    where profile.organization_id = seeded.partner_organization_id;
    delete from public.organizations organization
    where organization.id = seeded.partner_organization_id;
  end if;
  return pg_catalog.jsonb_build_object('removed', true, 'records', 1);
end;
$function$;

create function private.demo_seed_coordination_after_evidence_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  seeded_run record;
begin
  for seeded_run in
    select distinct evidence.lane, evidence.run_id
    from inserted_coordination_evidence evidence
    where evidence.function_id between 'CR-053' and 'CR-067'
  loop
    perform private.demo_seed_apply_organization_coordination(
      seeded_run.lane, seeded_run.run_id
    );
  end loop;
  return null;
end;
$function$;

create trigger demo_seed_coordination_after_evidence_insert
after insert on private.demo_seed_function_evidence
referencing new table as inserted_coordination_evidence
for each statement execute function private.demo_seed_coordination_after_evidence_insert();

create function private.demo_seed_coordination_after_evidence_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  seeded_run record;
begin
  for seeded_run in
    select distinct evidence.lane, evidence.run_id
    from deleted_coordination_evidence evidence
    where evidence.function_id between 'CR-053' and 'CR-067'
  loop
    perform private.demo_seed_remove_organization_coordination(
      seeded_run.lane, seeded_run.run_id
    );
  end loop;
  return null;
end;
$function$;

create trigger demo_seed_coordination_after_evidence_delete
after delete on private.demo_seed_function_evidence
referencing old table as deleted_coordination_evidence
for each statement execute function private.demo_seed_coordination_after_evidence_delete();

create function private.demo_seed_coordination_page_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  seeded_run record;
begin
  if pg_catalog.pg_trigger_depth() > 1 then return null; end if;
  for seeded_run in
    select distinct evidence.lane, evidence.run_id,
      run.organization_id, run.chapter_id, run.section_prefix
    from inserted_page_evidence evidence
    join private.demo_seed_coordination_runs run
      on run.lane = evidence.lane and run.run_id = evidence.run_id
  loop
    insert into private.demo_seed_page_evidence (
      lane, run_id, surface, actual_rows
    ) values
      (seeded_run.lane, seeded_run.run_id, 'organizationCoordination',
        (select pg_catalog.count(*)
         from public.organization_coordination_records record
         where record.organization_id = seeded_run.organization_id
           and record.config ->> 'demoRunId' = seeded_run.run_id::text)),
      (seeded_run.lane, seeded_run.run_id, 'organizationCoordinationMessages',
        (select pg_catalog.count(*)
         from public.organization_coordination_messages message
         join public.organization_coordination_records record
           on record.id = message.conversation_id
         where record.organization_id = seeded_run.organization_id
           and record.config ->> 'demoRunId' = seeded_run.run_id::text)),
      (seeded_run.lane, seeded_run.run_id, 'publicChapterMicrositePages',
        (select pg_catalog.count(*)
         from public.public_chapter_pages page
         where page.organization_id = seeded_run.organization_id
           and page.chapter_code = seeded_run.chapter_id
           and page.section_slug like seeded_run.section_prefix || '%'))
    on conflict (lane, run_id, surface) do update
      set actual_rows = excluded.actual_rows,
          recorded_at = pg_catalog.now();
  end loop;
  return null;
end;
$function$;

create trigger demo_seed_coordination_page_evidence
after insert on private.demo_seed_page_evidence
referencing new table as inserted_page_evidence
for each statement execute function private.demo_seed_coordination_page_evidence();

revoke all on function private.demo_seed_apply_organization_coordination(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_remove_organization_coordination(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_coordination_after_evidence_insert()
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_coordination_after_evidence_delete()
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_coordination_page_evidence()
  from public, anon, authenticated, service_role;

select pg_catalog.pg_notify('pgrst', 'reload schema');
