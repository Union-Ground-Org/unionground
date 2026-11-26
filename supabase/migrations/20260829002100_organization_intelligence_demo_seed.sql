-- SAMPLE-only evidence for CR-047, CR-048, CR-050, CR-051, and CR-052.
-- Version 20260829002100 follows the organization-intelligence foundation.
--
-- This migration creates no organization or user and inserts no feature data
-- while migrations run. The existing Union Ground and union-demo seed
-- lanes have already authenticated the pinned SAMPLE installation before they
-- write private.demo_seed_function_evidence. A private trigger uses that
-- authorized, deterministic run to add or remove realistic fictional rows.

set local lock_timeout = '5s';

update private.demo_seed_function_catalog
set coverage = 'seeded',
    evidence_key = case function_id
      when 'CR-047' then 'organization-charts'
      when 'CR-048' then 'neuro-map'
      when 'CR-050' then 'leadership-payroll-timeline'
      when 'CR-051' then 'digital-picket-line'
      when 'CR-052' then 'action-participant-exports'
    end,
    gate_relation = null
where function_id in ('CR-047', 'CR-048', 'CR-050', 'CR-051', 'CR-052');

insert into private.demo_seed_page_contract
  (surface, page_size, minimum_rows, scope, source)
values
  ('collectiveActions', 25, 50, 'organization', 'src/features/organizationIntelligence/contract.js')
on conflict (surface) do update set
  page_size = excluded.page_size,
  minimum_rows = excluded.minimum_rows,
  scope = excluded.scope,
  source = excluded.source;

create function private.demo_seed_remove_organization_intelligence(
  p_lane text,
  p_run_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.member_stress_uuid(
    p_run_id::text || case when p_lane = 'presg' then ':presg:organization' else ':ud:organization' end
  );
begin
  if p_lane not in ('presg', 'uniondemo') then raise exception 'unknown demo lane'; end if;

  -- The lane owns the entire fictional organization. Clearing the complete
  -- feature domain also removes visitor-created SAMPLE rows that have no
  -- deterministic id and would otherwise block the later organization delete.
  delete from public.digital_action_exports where organization_id = org;
  delete from public.organization_intelligence_audit_events where organization_id = org;
  delete from public.digital_action_participants where organization_id = org;
  delete from public.digital_actions where organization_id = org;
  delete from public.organization_topic_progress where organization_id = org;
  delete from public.organization_relationships where organization_id = org;
  delete from public.organization_timeline_events where organization_id = org;
  update public.organization_chart_nodes set parent_id = null where organization_id = org;
  delete from public.organization_chart_nodes where organization_id = org;
end;
$function$;

create function private.demo_seed_apply_organization_intelligence(
  p_lane text,
  p_run_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.member_stress_uuid(
    p_run_id::text || case when p_lane = 'presg' then ':presg:organization' else ':ud:organization' end
  );
  chapter text;
  actor uuid;
  action_id uuid;
  row_user uuid;
  member_count integer;
  n integer;
  participant integer;
begin
  if p_lane not in ('presg', 'uniondemo') then raise exception 'unknown demo lane'; end if;
  if p_lane = 'presg' and not exists (
    select 1 from private.presg_demo_runs r where r.id = p_run_id and r.state in ('applied', 'verified')
  ) then raise exception 'presg demo run is not applied'; end if;
  if p_lane = 'uniondemo' and not exists (
    select 1 from private.uniondemo_runs r where r.id = p_run_id and r.state in ('applied', 'verified')
  ) then raise exception 'union demo run is not applied'; end if;
  if not exists (select 1 from public.organizations o where o.id = org and o.status = 'active') then
    raise exception 'demo organization is missing';
  end if;

  perform private.demo_seed_remove_organization_intelligence(p_lane, p_run_id);
  if p_lane = 'presg' then
    select r.member_count into member_count from private.presg_demo_runs r where r.id = p_run_id;
  else
    select r.member_count into member_count from private.uniondemo_runs r where r.id = p_run_id;
  end if;
  chapter := private.demo_seed_chapter(p_lane, p_run_id, 1);
  actor := private.demo_seed_user(p_lane, p_run_id, 1);

  for n in 1..25 loop
    insert into public.organization_chart_nodes (
      id, organization_id, chapter_id, chart_kind, node_kind, parent_id,
      label, subtitle, position_x, position_y, sort_order, created_by, updated_by
    ) values (
      private.member_stress_uuid(p_run_id::text || ':org-intelligence:chart:agency:' || n),
      org, null, 'agency', case when n = 1 then 'organization' else 'division' end,
      case when n = 1 then null else private.member_stress_uuid(p_run_id::text || ':org-intelligence:chart:agency:1') end,
      case when n = 1 then 'Human Services Agency' else 'Regional operations division ' || pg_catalog.lpad((n - 1)::text, 2, '0') end,
      case when n = 1 then 'Agency reporting structure' else 'Service delivery and workplace operations' end,
      case when n = 1 then 50 else 10 + (((n - 2) % 5) * 20) end,
      case when n = 1 then 5 else 22 + (((n - 2) / 5) * 16) end,
      n, actor, actor
    );

    insert into public.organization_chart_nodes (
      id, organization_id, chapter_id, chart_kind, node_kind, parent_id,
      label, subtitle, position_x, position_y, sort_order, created_by, updated_by
    ) values (
      private.member_stress_uuid(p_run_id::text || ':org-intelligence:chart:union:' || n),
      org, case when n = 1 then null else private.demo_seed_chapter(p_lane, p_run_id, n - 1) end,
      'union', case when n = 1 then 'organization' else 'chapter' end,
      case when n = 1 then null else private.member_stress_uuid(p_run_id::text || ':org-intelligence:chart:union:1') end,
      case when n = 1 then 'Statewide Council' else 'Chapter leadership circle ' || pg_catalog.lpad((n - 1)::text, 2, '0') end,
      case when n = 1 then 'Organization-wide member governance' else 'Chapter officers, stewards, and workplace leaders' end,
      case when n = 1 then 50 else 10 + (((n - 2) % 5) * 20) end,
      case when n = 1 then 5 else 22 + (((n - 2) / 5) * 16) end,
      n, actor, actor
    );
  end loop;

  for n in 1..least(100, member_count - 1) loop
    insert into public.organization_relationships (
      id, organization_id, source_user_id, target_user_id, relationship_kind,
      strength, created_by, updated_by
    ) values (
      private.member_stress_uuid(p_run_id::text || ':org-intelligence:relationship:' || n),
      org, private.demo_seed_user(p_lane, p_run_id, n),
      private.demo_seed_user(p_lane, p_run_id, n + 1),
      (array['reports_to','works_with','mentors','organizes_with','trusted_contact'])[1 + (n % 5)],
      1 + (n % 5), actor, actor
    );

    insert into public.organization_topic_progress (
      organization_id, member_user_id, topic_key, topic_label,
      progress_state, progress, updated_by
    ) values (
      org, private.demo_seed_user(p_lane, p_run_id, n),
      'organization_readiness', 'Organization readiness',
      (array['introduced','developing','ready'])[1 + (n % 3)],
      20 + (n % 81), actor
    );
  end loop;

  if member_count <= 100 then
    for n in greatest(1, member_count)..least(100, member_count) loop
      insert into public.organization_topic_progress (
        organization_id, member_user_id, topic_key, topic_label,
        progress_state, progress, updated_by
      ) values (
        org, private.demo_seed_user(p_lane, p_run_id, n),
        'organization_readiness', 'Organization readiness',
        (array['introduced','developing','ready'])[1 + (n % 3)],
        20 + (n % 81), actor
      ) on conflict (organization_id, member_user_id, topic_key) do nothing;
    end loop;
  end if;

  for n in 1..50 loop
    insert into public.organization_timeline_events (
      id, organization_id, chapter_id, event_kind, title, detail,
      effective_on, ended_on, amount_cents, amount_basis, source_label,
      source_as_of, created_by, updated_by
    ) values (
      private.member_stress_uuid(p_run_id::text || ':org-intelligence:timeline:' || n),
      org, case when n % 3 = 0 then chapter else null end,
      case when n % 4 = 0 then 'payroll_snapshot' else 'leadership_term' end,
      case when n % 4 = 0 then 'Annual workforce payroll summary ' || (2026 - (n / 4))
        else 'Leadership milestone ' || pg_catalog.lpad(n::text, 2, '0') end,
      case when n % 4 = 0 then 'Aggregate organization-provided workforce total.'
        else 'Recorded transition in the organization leadership history.' end,
      current_date - (n * 30), null,
      case when n % 4 = 0 then 1200000000 + (n * 2500000) else null end,
      case when n % 4 = 0 then 'Annual aggregate' else null end,
      case when n % 4 = 0 then 'Organization-provided payroll summary' else null end,
      case when n % 4 = 0 then current_date - (n * 30) else null end,
      actor, actor
    );
  end loop;

  for n in 1..60 loop
    action_id := private.member_stress_uuid(p_run_id::text || ':org-intelligence:action:' || n);
    insert into public.digital_actions (
      id, organization_id, chapter_id, action_kind, title, summary, status,
      target_count, starts_at, ends_at, published_at, created_by, updated_by,
      created_at, updated_at
    ) values (
      action_id, org, private.demo_seed_chapter(p_lane, p_run_id, n),
      (array['petition','rally','picket','meeting','other'])[1 + (n % 5)],
      (array['Safe staffing commitment','Budget hearing turnout','Fair schedule pledge','Workplace safety delegation','Member outreach drive'])[1 + (n % 5)] || ' ' || pg_catalog.lpad(n::text, 2, '0'),
      'A realistic collective action with a clear commitment, timeline, and measurable participation goal.',
      case when n <= 45 then 'published' when n <= 50 then 'closed' else 'draft' end,
      case when n = 1 then 600 else 100 + ((n % 5) * 25) end,
      pg_catalog.now() - ((90 - n) || ' days')::interval,
      case when n between 46 and 50 then pg_catalog.now() - ((51 - n) || ' days')::interval else null end,
      case when n <= 50 then pg_catalog.now() - ((90 - n) || ' days')::interval else null end,
      actor, actor, pg_catalog.now() - ((90 - n) || ' days')::interval,
      pg_catalog.now() - ((60 - n) || ' hours')::interval
    );

    if n = 1 then
      for participant in 1..least(300, member_count) loop
        insert into public.digital_action_participants (
          organization_id, action_id, user_id, participation_kind, joined_at, updated_at
        ) values (
          org, action_id, private.demo_seed_user(p_lane, p_run_id, participant),
          case when participant <= 100 then 'signature' when participant <= 200 then 'attendee' else 'volunteer' end,
          pg_catalog.now() - ((301 - participant) || ' minutes')::interval,
          pg_catalog.now() - ((301 - participant) || ' minutes')::interval
        );
      end loop;
    elsif n <= 50 then
      for participant in 1..(20 + (n % 20)) loop
        row_user := private.demo_seed_user(p_lane, p_run_id, participant + n);
        insert into public.digital_action_participants (
          organization_id, action_id, user_id, participation_kind, joined_at, updated_at
        ) values (
          org, action_id, row_user,
          (array['signature','attendee','volunteer'])[1 + (participant % 3)],
          pg_catalog.now() - ((participant + n) || ' hours')::interval,
          pg_catalog.now() - ((participant + n) || ' hours')::interval
        ) on conflict (action_id, user_id) do update set
          participation_kind = excluded.participation_kind,
          joined_at = excluded.joined_at,
          updated_at = excluded.updated_at;
      end loop;
    end if;
  end loop;
end;
$function$;

create function private.demo_seed_sync_organization_intelligence_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' and new.function_id = 'CR-047' then
    perform private.demo_seed_apply_organization_intelligence(new.lane, new.run_id);
    return new;
  elsif tg_op = 'DELETE' and old.function_id = 'CR-047' then
    perform private.demo_seed_remove_organization_intelligence(old.lane, old.run_id);
    return old;
  end if;
  if tg_op = 'INSERT' then return new; end if;
  return old;
end;
$function$;

create trigger demo_seed_sync_organization_intelligence_evidence
before insert or delete on private.demo_seed_function_evidence
for each row execute function private.demo_seed_sync_organization_intelligence_evidence();

create or replace function private.demo_seed_record_page_evidence(
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
    (p_lane, p_run_id, 'chapterAppointments', (select pg_catalog.count(*) from public.member_appointments a join public.chapters c on c.id = a.chapter_id where c.organization_id = p_organization_id)),
    (p_lane, p_run_id, 'collectiveActions', (select pg_catalog.count(*) from public.digital_actions a where a.organization_id = p_organization_id and a.status <> 'draft'));

  return pg_catalog.jsonb_build_object(
    'ok', not exists (
      select 1 from private.demo_seed_page_contract c
      left join private.demo_seed_page_evidence e
        on e.surface = c.surface and e.lane = p_lane and e.run_id = p_run_id
      where e.surface is null or e.actual_rows < c.minimum_rows
    ),
    'surfaces', (select pg_catalog.jsonb_object_agg(c.surface, pg_catalog.jsonb_build_object(
      'actual', coalesce(e.actual_rows, 0), 'minimum', c.minimum_rows,
      'pageSize', c.page_size, 'ok', coalesce(e.actual_rows, 0) >= c.minimum_rows))
      from private.demo_seed_page_contract c
      left join private.demo_seed_page_evidence e
        on e.surface = c.surface and e.lane = p_lane and e.run_id = p_run_id)
  );
end;
$function$;

revoke all on function private.demo_seed_remove_organization_intelligence(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_apply_organization_intelligence(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_sync_organization_intelligence_evidence()
  from public, anon, authenticated, service_role;

comment on function private.demo_seed_apply_organization_intelligence(text, uuid) is
  'Deterministic SAMPLE-only organization-intelligence and collective-action evidence. Called only from an already-authorized demo seed evidence transaction.';
