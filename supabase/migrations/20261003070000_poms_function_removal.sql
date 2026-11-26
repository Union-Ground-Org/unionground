-- REQ-UG-POMS-FUNCTION-REMOVAL-20261003. Owner decision, October 3, 2026,
-- 3:13 PM ET: "yes delete it all. everything poms needs to go."
--
-- BINDING DISPOSITION. The POMS function that 20260830170000 installed beside
-- Field Notes and Action Lab is REMOVED, together with its stored data:
--
--   organization_poms_sources, organization_poms_ingest_chunks,
--   organization_poms_evidence (tables and every row)                   DROPPED
--   save_poms_source, update_poms_source, authorize_poms_ingestion,
--   complete_poms_ingestion, reconcile_poms_ingestion_completion,
--   add_poms_evidence                                                   DROPPED
--   organization_object_action_runs rows with target_kind 'poms_source'
--   (the POMS action history) and that target kind with its four actions DELETED
--   chapter_documents.document_type 'poms' (20260727211853, 20260810193000,
--   20260813180000)                                                      RETIRED
--   SAMPLE demo-seed function CR-070 and the administrativePomsSources /
--   administrativePomsEvidence page-depth surfaces                      RETIRED
--
-- WHAT IS DELETED, PRECISELY. Only rows that are POMS: the three POMS tables
-- whole, action-history rows whose target is a POMS source, and the SAMPLE
-- demo-seed page evidence for the two POMS surfaces. A NOTICE reports the
-- counts. Field Notes sources, blocks and packets, every other action-history
-- row, the desk RPC, the action RPC and their authorization stay unchanged.
--
-- WHAT IS RE-FILED, NOT DELETED. Chapter library documents filed under the
-- retired 'poms' category move to 'other'. They are the organization's own
-- uploads, and message resources, handshakes, coordination pages and public
-- pages can hold RESTRICT references to them, so deleting them would reach
-- into unrelated features. Their content, version and visibility stay.
--
-- SAMPLE DEMO SEED. The administrative seed now starts from CR-076 (Field
-- Notes) instead of CR-070, and its 50 Action Lab history rows per run target
-- the seeded Field Notes blocks instead of POMS sources. For runs already
-- seeded, the deleted POMS history rows are replaced in place (same
-- deterministic ids), so recorded page depth stays true. CR-070 stays in the
-- 114-function catalog with the new coverage 'owner-retired' and no evidence
-- key. Production holds no demo-seed runs, so these statements touch nothing
-- there.
--
-- Function bodies below are the newest installed definitions, read from a
-- fully migrated database, with only the POMS parts removed; the case-graph
-- and message-lifecycle entry gates of 20260907122000 / 20260907151000 stay.
--
-- ROLLBACK needs a new owner decision reversing this disposition. The deleted
-- rows cannot be recovered from the database after this migration commits.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $poms_removal_counts$
begin
  raise notice 'POMS removal deletes % sources, % retained chunks, % evidence bookmarks and % action-history rows, and re-files % library documents',
    (select pg_catalog.count(*) from public.organization_poms_sources),
    (select pg_catalog.count(*) from public.organization_poms_ingest_chunks),
    (select pg_catalog.count(*) from public.organization_poms_evidence),
    (select pg_catalog.count(*) from public.organization_object_action_runs where target_kind = 'poms_source'),
    (select pg_catalog.count(*) from public.chapter_documents where document_type = 'poms');
end;
$poms_removal_counts$;

-- 1. SAMPLE demo seed: retire CR-070 and its two page-depth surfaces.
alter table private.demo_seed_function_catalog
  drop constraint demo_seed_function_catalog_coverage_check,
  drop constraint demo_seed_function_catalog_evidence_complete,
  add constraint demo_seed_function_catalog_coverage_check
    check (coverage in ('seeded', 'schema-not-yet-landed', 'activation-unset', 'owner-retired')),
  add constraint demo_seed_function_catalog_evidence_complete check (
    (coverage = 'seeded' and evidence_key is not null and gate_relation is null)
    or (coverage = 'activation-unset' and evidence_key is not null and gate_relation is null)
    or (coverage = 'schema-not-yet-landed' and evidence_key is null)
    or (coverage = 'owner-retired' and evidence_key is null and gate_relation is null)
  );

alter table private.demo_seed_function_evidence
  drop constraint demo_seed_function_evidence_status_check,
  add constraint demo_seed_function_evidence_status_check
    check (status in ('seeded', 'schema-not-yet-landed', 'activation-unset', 'owner-retired'));

update private.demo_seed_function_catalog
set coverage = 'owner-retired', evidence_key = null, gate_relation = null
where function_id = 'CR-070';

update private.demo_seed_function_evidence
set status = 'owner-retired', evidence_key = null
where function_id = 'CR-070';

CREATE OR REPLACE FUNCTION private.demo_seed_sync_administrative_evidence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  if tg_op='INSERT' and new.function_id='CR-076' then
    perform private.demo_seed_apply_administrative_evidence(new.lane,new.run_id);
    return new;
  elsif tg_op='DELETE' and old.function_id='CR-076' then
    perform private.demo_seed_remove_administrative_evidence(old.lane,old.run_id);
    return old;
  end if;
  if tg_op='INSERT' then return new; end if;
  return old;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.demo_seed_remove_administrative_evidence(p_lane text, p_run_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.member_stress_uuid(p_run_id::text || case when p_lane='presg' then ':presg:organization' else ':ud:organization' end);
begin
  if p_lane not in ('presg','uniondemo') then raise exception 'unknown demo lane'; end if;
  delete from public.organization_object_action_runs where organization_id=org;
  delete from public.organization_field_note_packets where organization_id=org;
  delete from public.organization_field_note_blocks where organization_id=org;
  delete from public.organization_field_note_sources where organization_id=org;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.demo_seed_apply_administrative_evidence(p_lane text, p_run_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.member_stress_uuid(p_run_id::text || case when p_lane='presg' then ':presg:organization' else ':ud:organization' end);
  actor uuid;
  note_source_id uuid;
  note_id uuid;
  packet_id uuid;
  ordinal integer;
  occurred_at timestamptz;
  issue text;
begin
  if p_lane not in ('presg','uniondemo') then raise exception 'unknown demo lane'; end if;
  if p_lane='presg' and not exists (select 1 from private.presg_demo_runs r where r.id=p_run_id and r.state in ('applied','verified')) then raise exception 'presg demo run is not applied'; end if;
  if p_lane='uniondemo' and not exists (select 1 from private.uniondemo_runs r where r.id=p_run_id and r.state in ('applied','verified')) then raise exception 'union demo run is not applied'; end if;
  if not exists (select 1 from public.organizations o where o.id=org and o.status='active') then raise exception 'demo organization is missing'; end if;
  actor := private.demo_seed_user(p_lane,p_run_id,case when p_lane='presg' then 1 else 3 end);
  if not exists (
    select 1 from public.organization_role_grants grant_row
    join public.organization_memberships membership
      on membership.organization_id=grant_row.organization_id and membership.user_id=grant_row.user_id and membership.status='active'
    where grant_row.organization_id=org and grant_row.user_id=actor and grant_row.role='admin'
  ) then raise exception 'administrative evidence seed actor is not an active Admin'; end if;
  perform private.demo_seed_remove_administrative_evidence(p_lane,p_run_id);

  for ordinal in 1..50 loop
    occurred_at := pg_catalog.now() - (((ordinal - 1) * 22) || ' days')::interval;
    issue := (array['accommodation','attendance','workplace-safety','scheduling','protected-leave'])[1 + ((ordinal - 1) % 5)];
    note_source_id := private.member_stress_uuid(p_run_id::text || ':administrative:field-source:' || ordinal);
    note_id := private.member_stress_uuid(p_run_id::text || ':administrative:field-note:' || ordinal);
    packet_id := private.member_stress_uuid(p_run_id::text || ':administrative:packet:' || ordinal);

    insert into public.organization_field_note_sources (
      id,organization_id,title,source_type,provenance,created_by,created_at
    ) values (
      note_source_id,org,
      (array['Member interview','Supervisor memorandum','Attendance record','Safety inspection','Schedule notice'])[1 + ((ordinal - 1) % 5)] || ' ' || pg_catalog.lpad(ordinal::text,2,'0'),
      (array['interview','document','observation','recording','other'])[1 + ((ordinal - 1) % 5)],
      (array['Recorded with consent','Member-provided copy','Organization record export','Steward observation log','Meeting follow-up note'])[1 + ((ordinal - 1) % 5)],
      actor,occurred_at
    );
    insert into public.organization_field_note_blocks (
      id,organization_id,source_id,issue_key,body,annotation,packet_state,created_by,created_at,updated_at
    ) values (
      note_id,org,note_source_id,issue,
      'The record documents a dated workplace event, the response, and the next evidence question for review.',
      'Confirm the timeline against the authorized source before marking the packet review ready.',
      case when ordinal % 7=0 then 'excluded' else 'included' end,
      actor,occurred_at,occurred_at
    );
    insert into public.organization_field_note_packets (
      id,organization_id,issue_key,title,body,status,created_by,created_at,updated_at
    ) select
      packet_id,org,issue,
      pg_catalog.initcap(pg_catalog.replace(issue,'-',' ')) || ' evidence packet ' || pg_catalog.lpad(ordinal::text,2,'0'),
      '## Field Note Evidence' || pg_catalog.chr(10) || 'Source title: ' || source.title || pg_catalog.chr(10) || 'Source type: ' || source.source_type || pg_catalog.chr(10) || 'Provenance: ' || source.provenance || pg_catalog.repeat(pg_catalog.chr(10), 2) || block.body ||
        case when block.annotation='' then '' else pg_catalog.repeat(pg_catalog.chr(10), 2) || 'Annotation: ' || block.annotation end,
      case when ordinal % 3=0 then 'review_ready' else 'draft' end,
      actor,occurred_at,occurred_at
    from public.organization_field_note_blocks block
    join public.organization_field_note_sources source on source.id=block.source_id and source.organization_id=org
    where block.organization_id=org and block.issue_key=issue and block.packet_state='included'
    order by block.created_at desc,block.id desc limit 1;
    insert into public.organization_object_action_runs (
      id,organization_id,target_kind,target_id,target_label,action_key,note,previous_state,resulting_state,actor_user_id,created_at
    ) select
      private.member_stress_uuid(p_run_id::text || ':administrative:action:' || ordinal),org,
      'field_note_block',block.id,block.issue_key || ' · ' || source.title,
      case block.packet_state when 'excluded' then 'exclude' else 'include' end,
      'Routine evidence review ' || pg_catalog.lpad(ordinal::text,2,'0'),
      pg_catalog.jsonb_build_object('packetState','draft'),
      pg_catalog.jsonb_build_object('packetState',block.packet_state),
      actor,occurred_at
    from public.organization_field_note_blocks block
    join public.organization_field_note_sources source on source.id=block.source_id and source.organization_id=org
    where block.organization_id=org and block.id=note_id;
  end loop;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.demo_seed_refresh_administrative_page_evidence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare seeded_run record; org uuid;
begin
  if pg_catalog.pg_trigger_depth() > 1 then return null; end if;
  for seeded_run in select distinct lane,run_id from inserted_administrative_page_evidence loop
    org := private.member_stress_uuid(seeded_run.run_id::text || case when seeded_run.lane='presg' then ':presg:organization' else ':ud:organization' end);
    insert into private.demo_seed_page_evidence (lane,run_id,surface,actual_rows) values
      (seeded_run.lane,seeded_run.run_id,'administrativeFieldNotes',(select pg_catalog.count(*) from public.organization_field_note_blocks where organization_id=org)),
      (seeded_run.lane,seeded_run.run_id,'administrativeFieldNotePackets',(select pg_catalog.count(*) from public.organization_field_note_packets where organization_id=org)),
      (seeded_run.lane,seeded_run.run_id,'administrativeObjectActions',(select pg_catalog.count(*) from public.organization_object_action_runs where organization_id=org))
    on conflict (lane,run_id,surface) do update set actual_rows=excluded.actual_rows,recorded_at=pg_catalog.now();
  end loop;
  return null;
end;
end;
$function$;

delete from private.demo_seed_page_evidence
where surface in ('administrativePomsSources', 'administrativePomsEvidence');
delete from private.demo_seed_page_contract
where surface in ('administrativePomsSources', 'administrativePomsEvidence');

-- 2. Action history: delete the POMS rows, then retire the target kind.
delete from public.organization_object_action_runs where target_kind = 'poms_source';

insert into public.organization_object_action_runs (
  id, organization_id, target_kind, target_id, target_label, action_key, note,
  previous_state, resulting_state, actor_user_id, created_at
)
select
  private.member_stress_uuid(seeded.run_id::text || ':administrative:action:' || series.ordinal),
  block.organization_id, 'field_note_block', block.id, block.issue_key || ' · ' || source.title,
  case block.packet_state when 'excluded' then 'exclude' else 'include' end,
  'Routine evidence review ' || pg_catalog.lpad(series.ordinal::text, 2, '0'),
  pg_catalog.jsonb_build_object('packetState', 'draft'),
  pg_catalog.jsonb_build_object('packetState', block.packet_state),
  block.created_by, block.created_at
from (select distinct run_id from private.demo_seed_function_evidence where function_id = 'CR-076') seeded
cross join pg_catalog.generate_series(1, 50) as series(ordinal)
join public.organization_field_note_blocks block
  on block.id = private.member_stress_uuid(seeded.run_id::text || ':administrative:field-note:' || series.ordinal)
join public.organization_field_note_sources source
  on source.id = block.source_id and source.organization_id = block.organization_id
where block.packet_state in ('included', 'excluded')
on conflict (id) do nothing;

alter table public.organization_object_action_runs
  drop constraint organization_object_action_runs_target_kind_check,
  drop constraint organization_object_action_runs_action,
  add constraint organization_object_action_runs_target_kind_check
    check (target_kind in ('field_note_block', 'field_note_packet', 'member_case', 'chapter_task', 'member_profile')),
  add constraint organization_object_action_runs_action check (
    (target_kind = 'field_note_block' and action_key in ('include', 'exclude'))
    or (target_kind = 'field_note_packet' and action_key = 'mark_review_ready')
    or (target_kind = 'member_case' and action_key = 'case_record_review')
    or (target_kind = 'chapter_task' and action_key = 'task_record_review')
    or (target_kind = 'member_profile' and action_key = 'member_record_review')
  );

-- 3. The desk and the reusable action keep their signatures and grants.
CREATE OR REPLACE FUNCTION public.get_administrative_evidence_desk(p_page integer DEFAULT 0, p_query text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller_org uuid := private.require_administrative_evidence_staff();
  page_offset integer;
  -- p_query is kept so clients cached before October 3, 2026 keep resolving
  -- this signature; it is still length-bounded but no longer searches anything.
  search_query text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_query, '')));
begin
  if p_page < 0 or p_page > 10000 then raise exception 'invalid evidence page' using errcode='22023'; end if;
  if pg_catalog.char_length(search_query) > 200 then raise exception 'evidence search is too long' using errcode='22023'; end if;
  page_offset := p_page * 25;
  return pg_catalog.jsonb_build_object(
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
      'notes', greatest((select pg_catalog.count(*) from public.organization_field_note_blocks where organization_id=caller_org), (select pg_catalog.count(*) from public.organization_field_note_packets where organization_id=caller_org)) > page_offset + 25,
      'actions', greatest(
        (select pg_catalog.count(*) from public.organization_object_action_runs where organization_id=caller_org),
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

CREATE OR REPLACE FUNCTION public.execute_administrative_object_action(p_target_kind text, p_target_id uuid, p_action_key text, p_note text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare caller_org uuid := private.require_administrative_evidence_staff(); before_state jsonb; after_state jsonb; target_label text; run_row public.organization_object_action_runs;
begin
  if p_target_kind='field_note_block' and p_action_key in ('include','exclude') then
    select pg_catalog.jsonb_build_object('packetState', b.packet_state), b.issue_key || ' · ' || s.title into before_state,target_label
    from public.organization_field_note_blocks b
    join public.organization_field_note_sources s on s.id=b.source_id and s.organization_id=caller_org
    where b.id=p_target_id and b.organization_id=caller_org for update of b;
    if before_state is null then raise exception 'target not found' using errcode='P0002'; end if;
    if before_state->>'packetState' = (case p_action_key when 'include' then 'included' else 'excluded' end) then
      raise exception 'evidence is already in the requested packet state' using errcode='22023';
    end if;
    update public.organization_field_note_blocks set packet_state=case p_action_key when 'include' then 'included' else 'excluded' end, updated_at=pg_catalog.now() where id=p_target_id and organization_id=caller_org returning pg_catalog.jsonb_build_object('packetState', packet_state) into after_state;
  elsif p_target_kind='field_note_packet' and p_action_key='mark_review_ready' then
    select pg_catalog.jsonb_build_object('status', p.status), p.title into before_state,target_label
    from public.organization_field_note_packets p where p.id=p_target_id and p.organization_id=caller_org for update;
    if before_state is null then raise exception 'target not found' using errcode='P0002'; end if;
    if before_state->>'status' <> 'draft' then raise exception 'packet is already review ready' using errcode='22023'; end if;
    update public.organization_field_note_packets set status='review_ready', updated_at=pg_catalog.now() where id=p_target_id and organization_id=caller_org and status='draft' returning pg_catalog.jsonb_build_object('status', status) into after_state;
  elsif p_target_kind='member_case' and p_action_key='case_record_review' then
    select pg_catalog.jsonb_build_object('status', cs.status), cs.reference into before_state,target_label
    from public.member_cases cs
    where cs.id=p_target_id and cs.organization_id=caller_org
      and private.casework_staff_can_access(cs.id);
    if before_state is null then raise exception 'target not found' using errcode='P0002'; end if;
    after_state := before_state || pg_catalog.jsonb_build_object('reviewRecorded', true);
  elsif p_target_kind='chapter_task' and p_action_key='task_record_review' then
    select pg_catalog.jsonb_build_object('status', task.status, 'blocked', task.blocked), task.chapter_id || ' task #' || task.task_number into before_state,target_label
    from public.chapter_tasks task join public.chapters chapter on chapter.id=task.chapter_id
    where task.id=p_target_id and chapter.organization_id=caller_org and task.deleted_at is null
      and exists (select 1 from public.member_profiles caller_profile where caller_profile.id=auth.uid() and caller_profile.chapter_id=task.chapter_id);
    if before_state is null then raise exception 'target not found' using errcode='P0002'; end if;
    after_state := before_state || pg_catalog.jsonb_build_object('reviewRecorded', true);
  elsif p_target_kind='member_profile' and p_action_key='member_record_review' then
    select pg_catalog.jsonb_build_object('membershipStatus', membership.status), 'Member ' || pg_catalog.substr(profile.id::text,1,8) into before_state,target_label
    from public.organization_memberships membership join public.member_profiles profile on profile.id=membership.user_id
    where membership.organization_id=caller_org and membership.user_id=p_target_id and membership.status='active';
    if before_state is null then raise exception 'target not found' using errcode='P0002'; end if;
    after_state := before_state || pg_catalog.jsonb_build_object('reviewRecorded', true);
  else raise exception 'unsupported object action' using errcode='22023';
  end if;
  insert into public.organization_object_action_runs (organization_id,target_kind,target_id,target_label,action_key,note,previous_state,resulting_state,actor_user_id)
  values (caller_org,p_target_kind,p_target_id,target_label,p_action_key,coalesce(pg_catalog.btrim(p_note),''),before_state,after_state,auth.uid()) returning * into run_row;
  return pg_catalog.jsonb_build_object('id',run_row.id,'targetKind',run_row.target_kind,'targetId',run_row.target_id,'actionKey',run_row.action_key);
end;
end;
$function$;

-- 4. The six POMS RPCs, then the three POMS tables with every stored row.
drop function public.save_poms_source(text, text, text, text);
drop function public.update_poms_source(uuid, timestamptz, text, text, text, text);
drop function public.authorize_poms_ingestion(uuid, text);
drop function public.complete_poms_ingestion(uuid, uuid, uuid, timestamptz, text, text, text, jsonb, text);
drop function public.reconcile_poms_ingestion_completion(uuid, uuid, uuid, timestamptz, text, text);
drop function public.add_poms_evidence(uuid, timestamptz, text, text, text);

drop table public.organization_poms_evidence;
drop table public.organization_poms_ingest_chunks;
drop table public.organization_poms_sources;

-- 5. Chapter library: re-file, then retire the category.
update public.chapter_documents set document_type = 'other' where document_type = 'poms';

alter table public.chapter_documents
  drop constraint chapter_documents_document_type_check,
  add constraint chapter_documents_document_type_check
    check (document_type in ('contract', 'policy', 'minutes', 'training', 'template', 'other'));

CREATE OR REPLACE FUNCTION public.update_chapter_document_content(p_id uuid, p_title text, p_document_type text, p_summary text, p_body text, p_visibility text, p_action text DEFAULT 'save'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare row public.chapter_documents%rowtype; chapter text := private.assert_publisher();
begin
  if p_action not in ('save','republish','archive') then raise exception 'invalid document action' using errcode='22023'; end if;
  if p_document_type not in ('contract','policy','minutes','training','template','other') or p_visibility not in ('chapter','staff') then raise exception 'invalid document fields' using errcode='22023'; end if;
  select d.* into row from public.chapter_documents d where d.id=p_id and d.chapter_id=chapter for update;
  if row.id is null then raise exception 'document unavailable' using errcode='22023'; end if;
  if p_action='save' and row.status='published' then raise exception 'published document requires a new version or archive' using errcode='55000'; end if;
  update public.chapter_documents d set title=btrim(p_title), document_type=p_document_type, summary=coalesce(p_summary,''), body=coalesce(p_body,''), visibility=p_visibility,
    status=case when p_action='archive' then 'archived' when p_action='republish' then 'published' else d.status end,
    version=case when p_action='republish' then d.version+1 else d.version end,
    published_at=case when p_action='republish' then now() else d.published_at end
  where d.id=p_id and d.chapter_id=chapter returning d.* into row;
  if row.id is null then raise exception 'document unavailable' using errcode='22023'; end if;
  return to_jsonb(row);
end;
end;
end;
$function$;

-- 6. Account-lifecycle bookkeeping: withdraw the dropped tables' manifest and
-- trigger reviews, and re-pin the four re-emitted demo-seed functions the
-- trigger surface reaches. Name-bound, counted, never a blanket acceptance.
delete from private.account_lifecycle_manifest where schema_name = 'public'
  and table_name in ('organization_poms_sources', 'organization_poms_ingest_chunks', 'organization_poms_evidence');
delete from private.account_lifecycle_transitive_fk_manifest where schema_name = 'public'
  and table_name in ('organization_poms_sources', 'organization_poms_ingest_chunks', 'organization_poms_evidence');
delete from private.account_lifecycle_trigger_review where kind = 'trigger' and schema_name = 'public'
  and table_name in ('organization_poms_sources', 'organization_poms_ingest_chunks', 'organization_poms_evidence');

do $poms_removal_review$
declare affected integer;
begin
  update private.account_lifecycle_trigger_review review
  set definition_hash = surface.definition_hash
  from private.account_lifecycle_trigger_surface() surface
  where surface.kind = review.kind and surface.schema_name = review.schema_name
    and surface.table_name = review.table_name and surface.object_name = review.object_name
    and review.kind = 'function' and review.schema_name = 'private' and review.table_name = ''
    and review.object_name in (
      'demo_seed_sync_administrative_evidence()',
      'demo_seed_remove_administrative_evidence(p_lane text, p_run_id uuid)',
      'demo_seed_apply_administrative_evidence(p_lane text, p_run_id uuid)',
      'demo_seed_refresh_administrative_page_evidence()');
  get diagnostics affected = row_count;
  if affected <> 4 then
    raise exception 'POMS removal re-pinned % demo-seed function reviews, expected 4', affected;
  end if;
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after POMS removal: %',
      (select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || '.' || i.trigger_name, ', ')
       from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after POMS removal';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after POMS removal';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
             where n.nspname in ('public', 'private') and p.prosrc ~* 'poms') then
    raise exception 'a routine still names POMS after its removal';
  end if;
end;
$poms_removal_review$;

notify pgrst, 'reload schema';

commit;
