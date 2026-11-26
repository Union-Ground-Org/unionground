-- Preserve later knowledge-library page evidence when the aggregate SAMPLE
-- parity recorder rebuilds its shared evidence table.
--
-- The knowledge activation deliberately runs before and after the aggregate
-- parity wrapper. Its three page contracts landed after the recorder's last
-- definition, so the recorder deleted their evidence and then treated the
-- missing rows as zero. Count the already-authorized SAMPLE rows directly;
-- this migration creates no tenant, identity, provider credential, delivery,
-- or feature data.

set local lock_timeout = '5s';

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
    (p_lane, p_run_id, 'collectiveActions', (select pg_catalog.count(*) from public.digital_actions a where a.organization_id = p_organization_id and a.status <> 'draft')),
    (p_lane, p_run_id, 'knowledgeStewardLibrary', (
      select pg_catalog.count(*)
      from public.organization_knowledge_files file
      where file.organization_id = p_organization_id
        and file.library = 'steward'
    )),
    (p_lane, p_run_id, 'knowledgeResourceCatalog', (
      select pg_catalog.count(*)
      from public.organization_knowledge_files file
      where file.organization_id = p_organization_id
        and file.published_to_catalog
        and file.review_status = 'approved'
        and file.scan_status = 'clean'
    )),
    (p_lane, p_run_id, 'knowledgeIngestSources', (
      select pg_catalog.count(*)
      from public.organization_knowledge_sources source
      where source.organization_id = p_organization_id
    ));

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

revoke all on function private.demo_seed_record_page_evidence(
  text, uuid, uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role;

comment on function private.demo_seed_record_page_evidence(
  text, uuid, uuid, uuid, uuid, uuid
) is 'Rebuilds aggregate SAMPLE page-depth evidence from current authorized rows, including the later knowledge-library surfaces.';
