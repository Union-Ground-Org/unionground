-- Repair the deterministic SAMPLE organization-intelligence seed upsert.
--
-- The original function declared a PL/pgSQL variable named action_id and then
-- used ON CONFLICT (action_id, user_id). PostgreSQL correctly rejected the
-- ambiguous action_id reference before any seed transaction could commit.
-- Target the table's named primary-key constraint instead. This migration is
-- schema-only until an already-authorized SAMPLE lane explicitly runs again.

set local lock_timeout = '5s';

create or replace function private.demo_seed_apply_organization_intelligence(
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
        ) on conflict on constraint digital_action_participants_pkey do update set
          participation_kind = excluded.participation_kind,
          joined_at = excluded.joined_at,
          updated_at = excluded.updated_at;
      end loop;
    end if;
  end loop;
end;
$function$;

revoke all on function private.demo_seed_apply_organization_intelligence(text, uuid)
  from public, anon, authenticated, service_role;

comment on function private.demo_seed_apply_organization_intelligence(text, uuid) is
  'Deterministic SAMPLE-only organization-intelligence and collective-action evidence. Participant upserts target the named primary-key constraint to avoid PL/pgSQL variable ambiguity.';
