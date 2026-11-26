-- The Admin evidence desk timed out at SAMPLE scale because both the visible
-- case target page and its has-next count called casework_staff_can_access once
-- per organization case. The RPC entry gate has already established an active
-- organization membership, MFA, and the Admin organization role. At that point
-- an organization predicate is the set-wise equivalent for target discovery;
-- execute_administrative_object_action keeps the casework authorization check
-- on the actual write.

set local lock_timeout = '5s';

create or replace function public.get_administrative_evidence_desk(p_page integer default 0, p_query text default '')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller_org uuid := private.require_administrative_evidence_staff();
  page_offset integer;
  search_query text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_query, '')));
begin
  if p_page < 0 or p_page > 10000 then raise exception 'invalid evidence page' using errcode='22023'; end if;
  if pg_catalog.char_length(search_query) > 200 then raise exception 'evidence search is too long' using errcode='22023'; end if;
  page_offset := p_page * 25;
  return pg_catalog.jsonb_build_object(
    'pomsSources', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', s.id, 'title', s.title, 'sourceUrl', s.source_url, 'status', s.status,
      'resumeCursor', s.resume_cursor, 'healthNote', s.health_note, 'updatedAt', s.updated_at,
      'ingestionStatus', s.ingestion_status, 'ingestedChunkCount', s.ingested_chunk_count,
      'lastIngestAt', s.last_ingest_at, 'lastIngestMode', s.last_ingest_mode, 'lastIngestError', s.last_ingest_error,
      'matchExcerpt', case when search_query = '' then null else (
        select pg_catalog.substr(chunk.content, greatest(pg_catalog.strpos(pg_catalog.lower(chunk.content), search_query) - 80, 1), 320)
        from public.organization_poms_ingest_chunks chunk
        where chunk.organization_id=caller_org and chunk.source_id=s.id
          and pg_catalog.strpos(pg_catalog.lower(chunk.content), search_query)>0
        order by chunk.chunk_index limit 1
      ) end,
      'evidenceCount', (select pg_catalog.count(*) from public.organization_poms_evidence e where e.organization_id = caller_org and e.source_id = s.id)
    ) order by s.updated_at desc, s.id desc) from (
      select s0.* from public.organization_poms_sources s0
      where s0.organization_id = caller_org and (
        search_query = ''
        or pg_catalog.strpos(pg_catalog.lower(pg_catalog.concat_ws(' ', s0.title, s0.source_url, s0.status, s0.resume_cursor, s0.health_note)), search_query) > 0
        or exists (
          select 1 from public.organization_poms_evidence e0
          where e0.organization_id = caller_org and e0.source_id = s0.id
            and pg_catalog.strpos(pg_catalog.lower(pg_catalog.concat_ws(' ', e0.label, e0.locator, e0.annotation, e0.barcode)), search_query) > 0
        )
        or exists (
          select 1 from public.organization_poms_ingest_chunks chunk0
          where chunk0.organization_id=caller_org and chunk0.source_id=s0.id
            and pg_catalog.lower(chunk0.content) like '%' || search_query || '%'
        )
      ) order by s0.updated_at desc, s0.id desc limit 25 offset page_offset
    ) s), '[]'::jsonb),
    'pomsEvidence', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.id, 'sourceId', e.source_id, 'sourceTitle', s.title, 'label', e.label,
      'locator', e.locator, 'annotation', e.annotation, 'barcode', e.barcode,
      'sourceContentSha256', e.source_content_sha256, 'sourceLastIngestAt', e.source_last_ingest_at,
      'sourceExcerpt', e.source_excerpt, 'createdAt', e.created_at
    ) order by e.created_at desc, e.id desc) from (
      select e0.* from public.organization_poms_evidence e0
      join public.organization_poms_sources s0 on s0.id=e0.source_id and s0.organization_id=caller_org
      where e0.organization_id = caller_org and (
        search_query = ''
        or pg_catalog.strpos(pg_catalog.lower(pg_catalog.concat_ws(' ', s0.title, e0.label, e0.locator, e0.annotation, e0.barcode)), search_query) > 0
      ) order by e0.created_at desc, e0.id desc limit 25 offset page_offset
    ) e join public.organization_poms_sources s on s.id = e.source_id and s.organization_id = caller_org), '[]'::jsonb),
    'fieldNoteBlocks', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', b.id, 'sourceId', b.source_id, 'sourceTitle', s.title, 'sourceType', s.source_type,
      'provenance', s.provenance, 'issueKey', b.issue_key, 'body', b.body,
      'annotation', b.annotation, 'packetState', b.packet_state, 'updatedAt', b.updated_at
    ) order by b.updated_at desc, b.id desc) from (select * from public.organization_field_note_blocks where organization_id = caller_org order by updated_at desc, id desc limit 25 offset page_offset) b join public.organization_field_note_sources s on s.id = b.source_id and s.organization_id = caller_org), '[]'::jsonb),
    'packets', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', p.id, 'issueKey', p.issue_key, 'title', p.title, 'body', p.body,
      'status', p.status, 'updatedAt', p.updated_at
    ) order by p.updated_at desc, p.id desc) from (select * from public.organization_field_note_packets where organization_id = caller_org order by updated_at desc, id desc limit 25 offset page_offset) p), '[]'::jsonb),
    'actions', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('targetKind','poms_source','actionKey','mark_ready','label','Mark POMS source ready'),
      pg_catalog.jsonb_build_object('targetKind','poms_source','actionKey','pause','label','Pause POMS source'),
      pg_catalog.jsonb_build_object('targetKind','field_note_block','actionKey','include','label','Include evidence in packet'),
      pg_catalog.jsonb_build_object('targetKind','field_note_block','actionKey','exclude','label','Exclude evidence from packet'),
      pg_catalog.jsonb_build_object('targetKind','field_note_packet','actionKey','mark_review_ready','label','Mark packet review ready'),
      pg_catalog.jsonb_build_object('targetKind','member_case','actionKey','case_record_review','label','Record case review'),
      pg_catalog.jsonb_build_object('targetKind','chapter_task','actionKey','task_record_review','label','Record task review'),
      pg_catalog.jsonb_build_object('targetKind','member_profile','actionKey','member_record_review','label','Record member review')
    ),
    'actionTargets', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'targetKind', t.target_kind, 'id', t.id, 'label', t.label
    ) order by t.target_kind, t.label, t.id) from (
      (select 'member_case'::text as target_kind, cs.id, cs.reference || ' · ' || cs.title as label
       from public.member_cases cs
       where cs.organization_id=caller_org
       order by cs.updated_at desc, cs.id desc limit 25 offset page_offset)
      union all
      (select 'chapter_task'::text, task.id, task.title
       from public.chapter_tasks task join public.chapters chapter on chapter.id=task.chapter_id
       where chapter.organization_id=caller_org and task.deleted_at is null
         and exists (select 1 from public.member_profiles caller_profile where caller_profile.id=auth.uid() and caller_profile.chapter_id=task.chapter_id)
       order by task.updated_at desc, task.id desc limit 25 offset page_offset)
      union all
      (select 'member_profile'::text, profile.id, profile.full_name
       from public.organization_memberships membership join public.member_profiles profile on profile.id=membership.user_id
       where membership.organization_id=caller_org and membership.status='active' order by profile.full_name, profile.id limit 25 offset page_offset)
    ) t), '[]'::jsonb),
    'history', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', r.id, 'targetKind', r.target_kind, 'targetId', r.target_id,
      'targetLabel', r.target_label, 'actionKey', r.action_key, 'note', r.note, 'previousState', r.previous_state,
      'resultingState', r.resulting_state, 'createdAt', r.created_at,
      'actorLabel', coalesce(nullif(pg_catalog.btrim(actor.full_name),''), case when r.actor_user_id is null then 'Deleted user' else 'User ' || pg_catalog.substr(r.actor_user_id::text,1,8) end)
    ) order by r.created_at desc, r.id desc)
    from (select * from public.organization_object_action_runs where organization_id = caller_org order by created_at desc, id desc limit 25 offset page_offset) r
    left join public.member_profiles actor on actor.id=r.actor_user_id), '[]'::jsonb),
    'page', p_page,
    'pageSize', 25,
    'hasNext', pg_catalog.jsonb_build_object(
      'poms', greatest(
        (select pg_catalog.count(*) from public.organization_poms_sources s0 where s0.organization_id=caller_org and (
          search_query='' or pg_catalog.strpos(pg_catalog.lower(pg_catalog.concat_ws(' ', s0.title, s0.source_url, s0.status, s0.resume_cursor, s0.health_note)), search_query)>0
          or exists (select 1 from public.organization_poms_evidence e0 where e0.organization_id=caller_org and e0.source_id=s0.id and pg_catalog.strpos(pg_catalog.lower(pg_catalog.concat_ws(' ', e0.label, e0.locator, e0.annotation, e0.barcode)), search_query)>0)
          or exists (select 1 from public.organization_poms_ingest_chunks chunk0 where chunk0.organization_id=caller_org and chunk0.source_id=s0.id and pg_catalog.lower(chunk0.content) like '%' || search_query || '%')
        )),
        (select pg_catalog.count(*) from public.organization_poms_evidence e0 join public.organization_poms_sources s0 on s0.id=e0.source_id and s0.organization_id=caller_org where e0.organization_id=caller_org and (
          search_query='' or pg_catalog.strpos(pg_catalog.lower(pg_catalog.concat_ws(' ', s0.title, e0.label, e0.locator, e0.annotation, e0.barcode)), search_query)>0
        ))
      ) > page_offset + 25,
      'notes', greatest((select pg_catalog.count(*) from public.organization_field_note_blocks where organization_id=caller_org), (select pg_catalog.count(*) from public.organization_field_note_packets where organization_id=caller_org)) > page_offset + 25,
      'actions', greatest(
        (select pg_catalog.count(*) from public.organization_object_action_runs where organization_id=caller_org),
        (select pg_catalog.count(*) from public.organization_poms_sources where organization_id=caller_org),
        (select pg_catalog.count(*) from public.organization_field_note_blocks where organization_id=caller_org),
        (select pg_catalog.count(*) from public.organization_field_note_packets where organization_id=caller_org),
        (select pg_catalog.count(*) from public.member_cases cs where cs.organization_id=caller_org),
        (select pg_catalog.count(*) from public.chapter_tasks task join public.chapters chapter on chapter.id=task.chapter_id
          where chapter.organization_id=caller_org and task.deleted_at is null
            and exists (select 1 from public.member_profiles caller_profile where caller_profile.id=auth.uid() and caller_profile.chapter_id=task.chapter_id)),
        (select pg_catalog.count(*) from public.organization_memberships where organization_id=caller_org and status='active')
      ) > page_offset + 25
    )
  );
end;
$function$;

comment on function public.get_administrative_evidence_desk(integer, text) is
  'Admin-only organization evidence desk; case target discovery is set-wise and actual case actions re-check casework authorization.';
