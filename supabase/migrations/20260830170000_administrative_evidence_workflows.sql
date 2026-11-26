-- CR-070 / CR-076 / CR-109: organization-scoped administrative evidence.
-- Repository-only ordering follows Main's 20260830161000 member-operations migration.
--
-- The approved donor supplied useful product anatomy only. Its tables,
-- tenant assumptions, service-role actions, crawler credentials, and
-- migration history are intentionally not reused. Zero organizations remains
-- valid and this migration inserts no tenant, user, credential, or fixture.

set local lock_timeout = '5s';

update private.demo_seed_function_catalog catalog
set coverage = 'seeded',
    evidence_key = evidence.evidence_key,
    gate_relation = null
from (values
  ('CR-070', 'administrative-poms-evidence'),
  ('CR-076', 'administrative-field-notes'),
  ('CR-109', 'administrative-object-actions')
) as evidence(function_id, evidence_key)
where catalog.function_id = evidence.function_id;

insert into private.demo_seed_page_contract (surface, page_size, minimum_rows, scope, source) values
  ('administrativePomsSources', 25, 50, 'organization', 'src/lib/memberApi.js:3846'),
  ('administrativePomsEvidence', 25, 50, 'organization', 'src/lib/memberApi.js:3846'),
  ('administrativeFieldNotes', 25, 50, 'organization', 'src/lib/memberApi.js:3846'),
  ('administrativeFieldNotePackets', 25, 50, 'organization', 'src/lib/memberApi.js:3846'),
  ('administrativeObjectActions', 25, 50, 'organization', 'src/lib/memberApi.js:3846')
on conflict (surface) do update set
  page_size = excluded.page_size,
  minimum_rows = excluded.minimum_rows,
  scope = excluded.scope,
  source = excluded.source;

create table public.organization_poms_sources (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  title text not null,
  source_url text,
  status text not null default 'draft' check (status in ('draft', 'ready', 'paused', 'failed')),
  resume_cursor text,
  health_note text not null default '',
  ingestion_status text not null default 'not_run' check (ingestion_status in ('not_run', 'running', 'healthy', 'failed')),
  ingested_chunk_count integer not null default 0 check (ingested_chunk_count between 0 and 32),
  last_ingest_at timestamptz,
  retained_content_at timestamptz,
  last_ingest_mode text check (last_ingest_mode in ('test', 'ingest')),
  last_ingest_error text,
  last_content_sha256 text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_poms_sources_title check (pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 200),
  constraint organization_poms_sources_url check (source_url is null or (pg_catalog.char_length(source_url) <= 2000 and source_url ~ '^https://')),
  constraint organization_poms_sources_health check (pg_catalog.char_length(health_note) <= 1000),
  constraint organization_poms_sources_cursor check (resume_cursor is null or pg_catalog.char_length(resume_cursor) <= 500),
  unique (organization_id, id)
);

create index organization_poms_sources_org_updated_idx
  on public.organization_poms_sources (organization_id, updated_at desc, id desc);
create index organization_poms_sources_created_by_idx
  on public.organization_poms_sources (created_by);

create table public.organization_poms_ingest_chunks (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  source_id uuid not null,
  chunk_index integer not null check (chunk_index between 0 and 31),
  content text not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, source_id, chunk_index),
  foreign key (organization_id, source_id) references public.organization_poms_sources(organization_id, id) on delete cascade,
  constraint organization_poms_ingest_chunks_content check (pg_catalog.char_length(content) between 1 and 8000)
);

create index organization_poms_ingest_chunks_source_idx
  on public.organization_poms_ingest_chunks (organization_id, source_id, chunk_index);
create index organization_poms_ingest_chunks_content_trgm_idx
  on public.organization_poms_ingest_chunks using gin ((pg_catalog.lower(content)) extensions.gin_trgm_ops);

create table public.organization_poms_evidence (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  source_id uuid not null,
  label text not null,
  locator text not null,
  annotation text not null default '',
  barcode text not null,
  source_content_sha256 text,
  source_last_ingest_at timestamptz,
  source_excerpt text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint organization_poms_evidence_label check (pg_catalog.char_length(pg_catalog.btrim(label)) between 1 and 200),
  constraint organization_poms_evidence_locator check (pg_catalog.char_length(pg_catalog.btrim(locator)) between 1 and 500),
  constraint organization_poms_evidence_annotation check (pg_catalog.char_length(annotation) <= 4000),
  constraint organization_poms_evidence_source_hash check (source_content_sha256 is null or source_content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint organization_poms_evidence_source_excerpt check (pg_catalog.char_length(source_excerpt) <= 1000),
  unique (organization_id, barcode),
  foreign key (organization_id, source_id) references public.organization_poms_sources(organization_id, id) on delete restrict
);

create index organization_poms_evidence_source_idx
  on public.organization_poms_evidence (organization_id, source_id, created_at desc);
create index organization_poms_evidence_created_by_idx
  on public.organization_poms_evidence (created_by);

create table public.organization_field_note_sources (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  title text not null,
  source_type text not null check (source_type in ('interview', 'document', 'observation', 'recording', 'other')),
  provenance text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint organization_field_note_sources_title check (pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 200),
  constraint organization_field_note_sources_provenance check (pg_catalog.char_length(pg_catalog.btrim(provenance)) between 1 and 2000),
  unique (organization_id, id)
);

create table public.organization_field_note_blocks (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  source_id uuid not null,
  issue_key text not null,
  body text not null,
  annotation text not null default '',
  packet_state text not null default 'draft' check (packet_state in ('draft', 'included', 'excluded')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_field_note_blocks_issue check (pg_catalog.char_length(pg_catalog.btrim(issue_key)) between 1 and 120),
  constraint organization_field_note_blocks_body check (pg_catalog.char_length(pg_catalog.btrim(body)) between 1 and 12000),
  constraint organization_field_note_blocks_annotation check (pg_catalog.char_length(annotation) <= 4000),
  foreign key (organization_id, source_id) references public.organization_field_note_sources(organization_id, id) on delete restrict
);

create index organization_field_note_sources_created_by_idx
  on public.organization_field_note_sources (created_by);

create index organization_field_note_blocks_issue_idx
  on public.organization_field_note_blocks (organization_id, issue_key, created_at desc);
create index organization_field_note_blocks_org_updated_idx
  on public.organization_field_note_blocks (organization_id, updated_at desc, id desc);
create index organization_field_note_blocks_created_by_idx
  on public.organization_field_note_blocks (created_by);

create table public.organization_field_note_packets (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  issue_key text not null,
  title text not null,
  body text not null,
  status text not null default 'draft' check (status in ('draft', 'review_ready')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_field_note_packets_issue check (pg_catalog.char_length(pg_catalog.btrim(issue_key)) between 1 and 120),
  constraint organization_field_note_packets_title check (pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 200),
  constraint organization_field_note_packets_body check (pg_catalog.char_length(body) <= 50000)
);

create table public.organization_object_action_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  target_kind text not null check (target_kind in ('poms_source', 'field_note_block', 'field_note_packet', 'member_case', 'chapter_task', 'member_profile')),
  target_id uuid not null,
  target_label text not null,
  action_key text not null,
  note text not null default '',
  previous_state jsonb not null,
  resulting_state jsonb not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint organization_object_action_runs_target_label check (pg_catalog.char_length(pg_catalog.btrim(target_label)) between 1 and 500),
  constraint organization_object_action_runs_note check (pg_catalog.char_length(note) <= 1000),
  constraint organization_object_action_runs_action check (
    (target_kind = 'poms_source' and action_key in ('mark_ready', 'pause', 'test_ingestion', 'ingest_source'))
    or (target_kind = 'field_note_block' and action_key in ('include', 'exclude'))
    or (target_kind = 'field_note_packet' and action_key = 'mark_review_ready')
    or (target_kind = 'member_case' and action_key = 'case_record_review')
    or (target_kind = 'chapter_task' and action_key = 'task_record_review')
    or (target_kind = 'member_profile' and action_key = 'member_record_review')
  ),
  constraint organization_object_action_runs_state_objects check (
    pg_catalog.jsonb_typeof(previous_state) = 'object'
    and pg_catalog.jsonb_typeof(resulting_state) = 'object'
  )
);

create index organization_field_note_packets_created_by_idx
  on public.organization_field_note_packets (created_by);
create index organization_field_note_packets_org_updated_idx
  on public.organization_field_note_packets (organization_id, updated_at desc, id desc);

create index organization_object_action_runs_org_created_idx
  on public.organization_object_action_runs (organization_id, created_at desc, id desc);
create index organization_object_action_runs_actor_user_idx
  on public.organization_object_action_runs (actor_user_id);

alter table public.organization_poms_sources enable row level security;
alter table public.organization_poms_ingest_chunks enable row level security;
alter table public.organization_poms_evidence enable row level security;
alter table public.organization_field_note_sources enable row level security;
alter table public.organization_field_note_blocks enable row level security;
alter table public.organization_field_note_packets enable row level security;
alter table public.organization_object_action_runs enable row level security;

create policy organization_poms_sources_staff_read on public.organization_poms_sources
  for select to authenticated using (private.has_organization_role(organization_id, array['admin']));
create policy organization_poms_ingest_chunks_staff_read on public.organization_poms_ingest_chunks
  for select to authenticated using (private.has_organization_role(organization_id, array['admin']));
create policy organization_poms_evidence_staff_read on public.organization_poms_evidence
  for select to authenticated using (private.has_organization_role(organization_id, array['admin']));
create policy organization_field_note_sources_staff_read on public.organization_field_note_sources
  for select to authenticated using (private.has_organization_role(organization_id, array['admin']));
create policy organization_field_note_blocks_staff_read on public.organization_field_note_blocks
  for select to authenticated using (private.has_organization_role(organization_id, array['admin']));
create policy organization_field_note_packets_staff_read on public.organization_field_note_packets
  for select to authenticated using (private.has_organization_role(organization_id, array['admin']));
create policy organization_object_action_runs_staff_read on public.organization_object_action_runs
  for select to authenticated using (private.has_organization_role(organization_id, array['admin']));

create policy mfa_assurance on public.organization_poms_sources
  as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_poms_ingest_chunks
  as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_poms_evidence
  as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_field_note_sources
  as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_field_note_blocks
  as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_field_note_packets
  as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_object_action_runs
  as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));

revoke all on public.organization_poms_sources, public.organization_poms_ingest_chunks, public.organization_poms_evidence,
  public.organization_field_note_sources, public.organization_field_note_blocks,
  public.organization_field_note_packets, public.organization_object_action_runs
  from public, anon, authenticated, service_role;
grant select on public.organization_poms_sources, public.organization_poms_ingest_chunks, public.organization_poms_evidence,
  public.organization_field_note_sources, public.organization_field_note_blocks,
  public.organization_field_note_packets, public.organization_object_action_runs
  to authenticated;

create function private.require_administrative_evidence_staff()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller_org uuid := private.current_member_organization();
begin
  if caller_org is null
     or not private.mfa_satisfied()
     or not private.has_organization_role(caller_org, array['admin']) then
    raise exception 'MFA-backed administrator authorization required' using errcode = '42501';
  end if;
  return caller_org;
end;
$function$;

revoke all on function private.require_administrative_evidence_staff() from public, anon, authenticated, service_role;

create function public.get_administrative_evidence_desk(p_page integer default 0, p_query text default '')
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
         and private.casework_staff_can_access(cs.id)
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
        (select pg_catalog.count(*) from public.member_cases cs where cs.organization_id=caller_org
          and private.casework_staff_can_access(cs.id)),
        (select pg_catalog.count(*) from public.chapter_tasks task join public.chapters chapter on chapter.id=task.chapter_id
          where chapter.organization_id=caller_org and task.deleted_at is null
            and exists (select 1 from public.member_profiles caller_profile where caller_profile.id=auth.uid() and caller_profile.chapter_id=task.chapter_id)),
        (select pg_catalog.count(*) from public.organization_memberships where organization_id=caller_org and status='active')
      ) > page_offset + 25
    )
  );
end;
$function$;

create function public.save_poms_source(p_title text, p_source_url text default null, p_resume_cursor text default null, p_health_note text default '')
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare caller_org uuid := private.require_administrative_evidence_staff(); saved public.organization_poms_sources;
begin
  insert into public.organization_poms_sources (organization_id,title,source_url,resume_cursor,health_note,created_by)
  values (caller_org, pg_catalog.btrim(p_title), nullif(pg_catalog.btrim(p_source_url),''), nullif(pg_catalog.btrim(p_resume_cursor),''), coalesce(pg_catalog.btrim(p_health_note),''), auth.uid()) returning * into saved;
  return pg_catalog.jsonb_build_object('id',saved.id,'title',saved.title,'status',saved.status);
end; $function$;

create function public.reconcile_poms_ingestion_completion(
  p_organization_id uuid,
  p_source_id uuid,
  p_actor_user_id uuid,
  p_expected_updated_at timestamptz,
  p_mode text,
  p_content_sha256 text
)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  source_row public.organization_poms_sources;
begin
  if (select auth.role()) <> 'service_role' or p_mode not in ('test','ingest')
     or p_organization_id is null or p_source_id is null or p_actor_user_id is null or p_expected_updated_at is null
     or p_content_sha256 is null or p_content_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid POMS ingestion reconciliation' using errcode='22023';
  end if;
  select * into source_row from public.organization_poms_sources source
  where source.id=p_source_id and source.organization_id=p_organization_id;
  if not found then return null; end if;
  if source_row.ingestion_status <> 'healthy'
     or source_row.last_ingest_mode is distinct from p_mode
     or not exists (
       select 1 from public.organization_object_action_runs run
       where run.organization_id=p_organization_id and run.target_kind='poms_source' and run.target_id=p_source_id
         and run.actor_user_id=p_actor_user_id and run.created_at>=p_expected_updated_at
         and run.action_key=case when p_mode='test' then 'test_ingestion' else 'ingest_source' end
         and run.resulting_state->>'ingestionStatus'='healthy'
         and run.resulting_state->>'contentSha256'=p_content_sha256
     ) then return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'id',source_row.id,'ingestionStatus',source_row.ingestion_status,
    'ingestedChunkCount',source_row.ingested_chunk_count,'lastIngestAt',source_row.last_ingest_at,
    'lastIngestMode',source_row.last_ingest_mode,'lastIngestError',source_row.last_ingest_error
  );
end; $function$;

create function public.update_poms_source(p_source_id uuid, p_expected_updated_at timestamptz, p_title text, p_source_url text default null, p_resume_cursor text default null, p_health_note text default '')
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare caller_org uuid := private.require_administrative_evidence_staff(); saved public.organization_poms_sources; identity_changed boolean;
begin
  select * into saved from public.organization_poms_sources
  where id=p_source_id and organization_id=caller_org for update;
  if not found then raise exception 'source not found' using errcode='P0002'; end if;
  if p_expected_updated_at is null or saved.updated_at is distinct from p_expected_updated_at then
    raise exception 'source changed; reload before saving' using errcode='40001';
  end if;
  if exists (select 1 from public.organization_poms_evidence where organization_id=caller_org and source_id=p_source_id)
     and (saved.title is distinct from pg_catalog.btrim(p_title)
       or saved.source_url is distinct from nullif(pg_catalog.btrim(p_source_url),'')) then
    raise exception 'source title and URL are immutable after evidence is bookmarked' using errcode='22023';
  end if;
  identity_changed := saved.title is distinct from pg_catalog.btrim(p_title)
    or saved.source_url is distinct from nullif(pg_catalog.btrim(p_source_url),'');
  if identity_changed then
    delete from public.organization_poms_ingest_chunks
    where organization_id=caller_org and source_id=p_source_id;
  end if;
  update public.organization_poms_sources
  set title=pg_catalog.btrim(p_title), source_url=nullif(pg_catalog.btrim(p_source_url),''),
      resume_cursor=nullif(pg_catalog.btrim(p_resume_cursor),''), health_note=coalesce(pg_catalog.btrim(p_health_note),''),
      ingestion_status=case when identity_changed then 'not_run' else ingestion_status end,
      ingested_chunk_count=case when identity_changed then 0 else ingested_chunk_count end,
      last_ingest_at=case when identity_changed then null else last_ingest_at end,
      retained_content_at=case when identity_changed then null else retained_content_at end,
      last_ingest_mode=case when identity_changed then null else last_ingest_mode end,
      last_ingest_error=case when identity_changed then null else last_ingest_error end,
      last_content_sha256=case when identity_changed then null else last_content_sha256 end,
      updated_at=pg_catalog.now()
  where id=p_source_id and organization_id=caller_org returning * into saved;
  return pg_catalog.jsonb_build_object('id',saved.id,'title',saved.title,'status',saved.status,'updatedAt',saved.updated_at);
end; $function$;

create function public.authorize_poms_ingestion(p_source_id uuid, p_mode text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  caller_org uuid := private.require_administrative_evidence_staff();
  source_row public.organization_poms_sources;
begin
  if p_mode not in ('test','ingest') then raise exception 'invalid POMS ingestion mode' using errcode='22023'; end if;
  select * into source_row from public.organization_poms_sources
  where id=p_source_id and organization_id=caller_org for update;
  if not found then raise exception 'source not found' using errcode='P0002'; end if;
  if source_row.source_url is null or source_row.source_url !~ '^https://secure[.]ssa[.]gov/' then
    raise exception 'POMS ingestion requires an allowlisted secure.ssa.gov URL' using errcode='22023';
  end if;
  if (source_row.ingestion_status='running' and source_row.last_ingest_at > pg_catalog.now() - interval '5 minutes') or exists (
    select 1 from public.organization_object_action_runs run
    where run.organization_id=caller_org and run.target_kind='poms_source' and run.target_id=p_source_id
      and run.action_key in ('test_ingestion','ingest_source') and run.created_at > pg_catalog.now() - interval '1 minute'
  ) then return pg_catalog.jsonb_build_object('rateLimited',true); end if;
  update public.organization_poms_sources
  set ingestion_status='running',last_ingest_at=pg_catalog.now(),last_ingest_mode=p_mode,
      last_ingest_error=null,updated_at=pg_catalog.now()
  where id=source_row.id and organization_id=caller_org returning * into source_row;
  return pg_catalog.jsonb_build_object(
    'organizationId',caller_org,'sourceId',source_row.id,'sourceUrl',source_row.source_url,
    'actorUserId',auth.uid(),'expectedUpdatedAt',source_row.updated_at,'rateLimited',false
  );
end; $function$;

create function public.complete_poms_ingestion(
  p_organization_id uuid,
  p_source_id uuid,
  p_actor_user_id uuid,
  p_expected_updated_at timestamptz,
  p_mode text,
  p_final_url text,
  p_content_sha256 text,
  p_chunks jsonb,
  p_error_code text
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  source_row public.organization_poms_sources;
  item record;
  item_count integer;
  error_code text := nullif(pg_catalog.btrim(coalesce(p_error_code,'')),'');
  before_state jsonb;
  after_state jsonb;
begin
  if pg_catalog.jsonb_typeof(coalesce(p_chunks,'[]'::jsonb)) <> 'array' then
    raise exception 'invalid POMS ingestion completion' using errcode='22023';
  end if;
  item_count := pg_catalog.jsonb_array_length(coalesce(p_chunks,'[]'::jsonb));
  if (select auth.role()) <> 'service_role' or p_mode not in ('test','ingest')
     or p_organization_id is null or p_source_id is null or p_actor_user_id is null or p_expected_updated_at is null
     or item_count > 32 or p_final_url is null
     or p_final_url !~ '^https://secure[.]ssa[.]gov/'
     or (p_content_sha256 is not null and p_content_sha256 !~ '^[0-9a-f]{64}$')
     or (error_code is not null and error_code !~ '^poms-[a-z0-9-]{1,100}$')
     or (p_mode='test' and item_count<>0) or (p_mode='ingest' and error_code is null and item_count=0) then
    raise exception 'invalid POMS ingestion completion' using errcode='22023';
  end if;
  select * into source_row from public.organization_poms_sources source
  where source.id=p_source_id and source.organization_id=p_organization_id for update;
  if not found then raise exception 'source not found' using errcode='P0002'; end if;
  if source_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'source changed; reload before completing ingestion' using errcode='40001';
  end if;
  if source_row.source_url !~ '^https://secure[.]ssa[.]gov/' then raise exception 'source URL is no longer allowlisted' using errcode='22023'; end if;
  if not exists (
    select 1 from public.organization_memberships membership
    join public.organization_role_grants role
      on role.organization_id=membership.organization_id and role.user_id=membership.user_id
    where membership.organization_id=p_organization_id and membership.user_id=p_actor_user_id
      and membership.status='active' and role.role='admin'
  ) then raise exception 'ingestion actor is no longer an active Admin' using errcode='42501'; end if;
  before_state := pg_catalog.jsonb_build_object(
    'ingestionStatus',source_row.ingestion_status,'chunkCount',source_row.ingested_chunk_count
  );
  if error_code is null and p_mode='ingest' then
    delete from public.organization_poms_ingest_chunks chunk
    where chunk.organization_id=p_organization_id and chunk.source_id=p_source_id;
    for item in select value,ordinality from pg_catalog.jsonb_array_elements_text(p_chunks) with ordinality loop
      if pg_catalog.char_length(item.value) not between 1 and 8000 then raise exception 'invalid POMS chunk' using errcode='22023'; end if;
      insert into public.organization_poms_ingest_chunks (
        organization_id,source_id,chunk_index,content,content_sha256
      ) values (
        p_organization_id,p_source_id,item.ordinality-1,item.value,
        pg_catalog.encode(extensions.digest(item.value,'sha256'),'hex')
      );
    end loop;
  end if;
  update public.organization_poms_sources
  set ingestion_status=case when error_code is null then 'healthy' else 'failed' end,
      ingested_chunk_count=case when error_code is null and p_mode='ingest' then item_count else ingested_chunk_count end,
      last_ingest_at=pg_catalog.now(),last_ingest_mode=p_mode,last_ingest_error=error_code,
      retained_content_at=case when error_code is null and p_mode='ingest' then pg_catalog.now() else retained_content_at end,
      last_content_sha256=case when error_code is null and p_mode='ingest' then p_content_sha256 else last_content_sha256 end,
      updated_at=pg_catalog.now()
  where id=p_source_id and organization_id=p_organization_id returning * into source_row;
  after_state := pg_catalog.jsonb_build_object(
    'ingestionStatus',source_row.ingestion_status,'chunkCount',source_row.ingested_chunk_count,
    'contentSha256',case when error_code is null then p_content_sha256 else null end
  );
  insert into public.organization_object_action_runs (
    organization_id,target_kind,target_id,target_label,action_key,note,previous_state,resulting_state,actor_user_id
  ) values (
    p_organization_id,'poms_source',p_source_id,source_row.title,
    case when p_mode='test' then 'test_ingestion' else 'ingest_source' end,
    case when error_code is null then 'Allowed source fetched and parsed.' else 'Operation failed: ' || error_code end,
    before_state,after_state,p_actor_user_id
  );
  return pg_catalog.jsonb_build_object(
    'id',source_row.id,'ingestionStatus',source_row.ingestion_status,
    'ingestedChunkCount',source_row.ingested_chunk_count,'lastIngestAt',source_row.last_ingest_at,
    'lastIngestMode',source_row.last_ingest_mode,'lastIngestError',source_row.last_ingest_error
  );
end; $function$;

create function public.add_poms_evidence(p_source_id uuid, p_expected_updated_at timestamptz, p_label text, p_locator text, p_annotation text default '')
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare caller_org uuid := private.require_administrative_evidence_staff(); source_row public.organization_poms_sources; saved public.organization_poms_evidence; code text; captured_excerpt text;
begin
  select * into source_row from public.organization_poms_sources
  where id=p_source_id and organization_id=caller_org for update;
  if not found then raise exception 'source not found' using errcode='P0002'; end if;
  if p_expected_updated_at is null or source_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'source changed; reload before bookmarking' using errcode='40001';
  end if;
  select pg_catalog.substr(chunk.content, 1, 1000) into captured_excerpt
  from public.organization_poms_ingest_chunks chunk
  where chunk.organization_id=caller_org and chunk.source_id=p_source_id
  order by
    case when pg_catalog.strpos(pg_catalog.lower(chunk.content), pg_catalog.lower(pg_catalog.btrim(p_locator))) > 0 then 0 else 1 end,
    chunk.chunk_index
  limit 1;
  code := 'POMS-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.replace(p_source_id::text,'-',''),1,8)) || '-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(4),'hex'),1,8));
  insert into public.organization_poms_evidence (organization_id,source_id,label,locator,annotation,barcode,source_content_sha256,source_last_ingest_at,source_excerpt,created_by)
  values (caller_org,p_source_id,pg_catalog.btrim(p_label),pg_catalog.btrim(p_locator),coalesce(pg_catalog.btrim(p_annotation),''),code,source_row.last_content_sha256,source_row.retained_content_at,coalesce(captured_excerpt,''),auth.uid()) returning * into saved;
  return pg_catalog.jsonb_build_object('id',saved.id,'barcode',saved.barcode);
end; $function$;

create function public.add_field_note_evidence(p_source_title text, p_source_type text, p_provenance text, p_issue_key text, p_body text, p_annotation text default '')
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare caller_org uuid := private.require_administrative_evidence_staff(); source_row public.organization_field_note_sources; block_row public.organization_field_note_blocks;
begin
  insert into public.organization_field_note_sources (organization_id,title,source_type,provenance,created_by)
  values (caller_org,pg_catalog.btrim(p_source_title),p_source_type,pg_catalog.btrim(p_provenance),auth.uid()) returning * into source_row;
  insert into public.organization_field_note_blocks (organization_id,source_id,issue_key,body,annotation,created_by)
  values (caller_org,source_row.id,pg_catalog.btrim(p_issue_key),pg_catalog.btrim(p_body),coalesce(pg_catalog.btrim(p_annotation),''),auth.uid()) returning * into block_row;
  return pg_catalog.jsonb_build_object('id',block_row.id,'sourceId',source_row.id,'issueKey',block_row.issue_key);
end; $function$;

create function public.draft_field_note_packet(p_issue_key text, p_title text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare caller_org uuid := private.require_administrative_evidence_staff(); packet_row public.organization_field_note_packets; packet_body text;
begin
  select coalesce(pg_catalog.string_agg('## ' || s.title || E'\nSource type: ' || s.source_type || E'\nProvenance: ' || s.provenance || E'\n\n' || b.body || case when b.annotation='' then '' else E'\n\nAnnotation: ' || b.annotation end, E'\n\n' order by b.created_at,b.id),'')
  into packet_body from public.organization_field_note_blocks b join public.organization_field_note_sources s on s.id=b.source_id and s.organization_id=caller_org
  where b.organization_id=caller_org and b.issue_key=pg_catalog.btrim(p_issue_key) and b.packet_state='included';
  if packet_body='' then raise exception 'packet requires included evidence' using errcode='22023'; end if;
  if pg_catalog.char_length(packet_body)>50000 then raise exception 'packet exceeds 50000 characters; exclude or split evidence before drafting' using errcode='22023'; end if;
  insert into public.organization_field_note_packets (organization_id,issue_key,title,body,created_by)
  values (caller_org,pg_catalog.btrim(p_issue_key),pg_catalog.btrim(p_title),packet_body,auth.uid()) returning * into packet_row;
  return pg_catalog.jsonb_build_object('id',packet_row.id,'status',packet_row.status,'body',packet_row.body);
end; $function$;

create function public.execute_administrative_object_action(p_target_kind text, p_target_id uuid, p_action_key text, p_note text default '')
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare caller_org uuid := private.require_administrative_evidence_staff(); before_state jsonb; after_state jsonb; target_label text; run_row public.organization_object_action_runs;
begin
  if p_target_kind='poms_source' and p_action_key in ('mark_ready','pause') then
    select pg_catalog.jsonb_build_object('status', s.status), s.title into before_state,target_label
    from public.organization_poms_sources s where s.id=p_target_id and s.organization_id=caller_org for update;
    if before_state is null then raise exception 'target not found' using errcode='P0002'; end if;
    if before_state->>'status' = (case p_action_key when 'mark_ready' then 'ready' else 'paused' end) then
      raise exception 'source is already in the requested state' using errcode='22023';
    end if;
    update public.organization_poms_sources set status=case p_action_key when 'mark_ready' then 'ready' else 'paused' end, updated_at=pg_catalog.now() where id=p_target_id and organization_id=caller_org returning pg_catalog.jsonb_build_object('status', status) into after_state;
  elsif p_target_kind='field_note_block' and p_action_key in ('include','exclude') then
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
end; $function$;

create function private.demo_seed_remove_administrative_evidence(p_lane text, p_run_id uuid)
returns void language plpgsql security definer set search_path = '' as $function$
declare
  org uuid := private.member_stress_uuid(p_run_id::text || case when p_lane='presg' then ':presg:organization' else ':ud:organization' end);
begin
  if p_lane not in ('presg','uniondemo') then raise exception 'unknown demo lane'; end if;
  delete from public.organization_object_action_runs where organization_id=org;
  delete from public.organization_field_note_packets where organization_id=org;
  delete from public.organization_field_note_blocks where organization_id=org;
  delete from public.organization_field_note_sources where organization_id=org;
  delete from public.organization_poms_evidence where organization_id=org;
  delete from public.organization_poms_ingest_chunks where organization_id=org;
  delete from public.organization_poms_sources where organization_id=org;
end; $function$;

create function private.demo_seed_apply_administrative_evidence(p_lane text, p_run_id uuid)
returns void language plpgsql security definer set search_path = '' as $function$
declare
  org uuid := private.member_stress_uuid(p_run_id::text || case when p_lane='presg' then ':presg:organization' else ':ud:organization' end);
  actor uuid;
  poms_id uuid;
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
    poms_id := private.member_stress_uuid(p_run_id::text || ':administrative:poms:' || ordinal);
    note_source_id := private.member_stress_uuid(p_run_id::text || ':administrative:field-source:' || ordinal);
    note_id := private.member_stress_uuid(p_run_id::text || ':administrative:field-note:' || ordinal);
    packet_id := private.member_stress_uuid(p_run_id::text || ':administrative:packet:' || ordinal);

    insert into public.organization_poms_sources (
      id,organization_id,title,source_url,status,resume_cursor,health_note,
      ingestion_status,ingested_chunk_count,last_ingest_at,retained_content_at,last_ingest_mode,last_content_sha256,
      created_by,created_at,updated_at
    ) values (
      poms_id,org,
      (array['Disability evaluation manual','Appeals operations guide','Evidence development handbook','Continuing review reference','Claims documentation manual'])[1 + ((ordinal - 1) % 5)] || ' ' || pg_catalog.lpad(ordinal::text,2,'0'),
      'https://secure.ssa.gov/poms.nsf/lnx/' || pg_catalog.lpad((4000000000 + ordinal)::text,10,'0'),
      case when ordinal % 4=3 then 'paused' else 'ready' end,
      'section-' || pg_catalog.lpad(ordinal::text,3,'0'),
      case when ordinal % 4=0 then 'Review queued after a source change.' else 'Source review completed; resume cursor retained.' end,
      'healthy',1,occurred_at,occurred_at,'ingest',pg_catalog.encode(extensions.digest('administrative-poms-content:' || ordinal,'sha256'),'hex'),
      actor,occurred_at,occurred_at
    );
    insert into public.organization_poms_ingest_chunks (
      id,organization_id,source_id,chunk_index,content,content_sha256,created_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':administrative:poms-chunk:' || ordinal),org,poms_id,0,
      'The authority source was fetched through the bounded POMS ingestion path and retained for authorized evidence discovery.',
      pg_catalog.encode(extensions.digest('The authority source was fetched through the bounded POMS ingestion path and retained for authorized evidence discovery.','sha256'),'hex'),occurred_at
    );
    insert into public.organization_poms_evidence (
      id,organization_id,source_id,label,locator,annotation,barcode,source_content_sha256,source_last_ingest_at,source_excerpt,created_by,created_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':administrative:poms-evidence:' || ordinal),org,poms_id,
      (array['Eligibility standard','Evidence sequence','Review window','Notice requirement','Documentation rule'])[1 + ((ordinal - 1) % 5)] || ' ' || pg_catalog.lpad(ordinal::text,2,'0'),
      'Chapter ' || (1 + (ordinal % 18)) || '.' || (1 + (ordinal % 9)),
      'Operator-authored explanation connecting this authority to the evidence workflow.',
      'POMS-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.replace(poms_id::text,'-',''),1,8)) || '-' || pg_catalog.lpad(ordinal::text,8,'0'),
      pg_catalog.encode(extensions.digest('administrative-poms-content:' || ordinal,'sha256'),'hex'),occurred_at,
      'The authority source was fetched through the bounded POMS ingestion path and retained for authorized evidence discovery.',actor,occurred_at
    );

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
      '## Field Note Evidence' || E'\nSource title: ' || source.title || E'\nSource type: ' || source.source_type || E'\nProvenance: ' || source.provenance || E'\n\n' || block.body ||
        case when block.annotation='' then '' else E'\n\nAnnotation: ' || block.annotation end,
      case when ordinal % 3=0 then 'review_ready' else 'draft' end,
      actor,occurred_at,occurred_at
    from public.organization_field_note_blocks block
    join public.organization_field_note_sources source on source.id=block.source_id and source.organization_id=org
    where block.organization_id=org and block.issue_key=issue and block.packet_state='included'
    order by block.created_at desc,block.id desc limit 1;
    insert into public.organization_object_action_runs (
      id,organization_id,target_kind,target_id,target_label,action_key,note,previous_state,resulting_state,actor_user_id,created_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':administrative:action:' || ordinal),org,
      'poms_source',poms_id,(select title from public.organization_poms_sources where organization_id=org and id=poms_id),
      case when ordinal % 4=3 then 'pause' else 'mark_ready' end,
      'Routine evidence review ' || pg_catalog.lpad(ordinal::text,2,'0'),
      pg_catalog.jsonb_build_object('status','draft'),
      pg_catalog.jsonb_build_object('status',case when ordinal % 4=3 then 'paused' else 'ready' end),
      actor,occurred_at
    );
  end loop;
end; $function$;

create function private.demo_seed_sync_administrative_evidence()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if tg_op='INSERT' and new.function_id='CR-070' then
    perform private.demo_seed_apply_administrative_evidence(new.lane,new.run_id);
    return new;
  elsif tg_op='DELETE' and old.function_id='CR-070' then
    perform private.demo_seed_remove_administrative_evidence(old.lane,old.run_id);
    return old;
  end if;
  if tg_op='INSERT' then return new; end if;
  return old;
end; $function$;

create trigger demo_seed_sync_administrative_evidence
before insert or delete on private.demo_seed_function_evidence
for each row execute function private.demo_seed_sync_administrative_evidence();

create function private.demo_seed_refresh_administrative_page_evidence()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare seeded_run record; org uuid;
begin
  if pg_catalog.pg_trigger_depth() > 1 then return null; end if;
  for seeded_run in select distinct lane,run_id from inserted_administrative_page_evidence loop
    org := private.member_stress_uuid(seeded_run.run_id::text || case when seeded_run.lane='presg' then ':presg:organization' else ':ud:organization' end);
    insert into private.demo_seed_page_evidence (lane,run_id,surface,actual_rows) values
      (seeded_run.lane,seeded_run.run_id,'administrativePomsSources',(select pg_catalog.count(*) from public.organization_poms_sources where organization_id=org)),
      (seeded_run.lane,seeded_run.run_id,'administrativePomsEvidence',(select pg_catalog.count(*) from public.organization_poms_evidence where organization_id=org)),
      (seeded_run.lane,seeded_run.run_id,'administrativeFieldNotes',(select pg_catalog.count(*) from public.organization_field_note_blocks where organization_id=org)),
      (seeded_run.lane,seeded_run.run_id,'administrativeFieldNotePackets',(select pg_catalog.count(*) from public.organization_field_note_packets where organization_id=org)),
      (seeded_run.lane,seeded_run.run_id,'administrativeObjectActions',(select pg_catalog.count(*) from public.organization_object_action_runs where organization_id=org))
    on conflict (lane,run_id,surface) do update set actual_rows=excluded.actual_rows,recorded_at=pg_catalog.now();
  end loop;
  return null;
end; $function$;

create trigger demo_seed_refresh_administrative_page_evidence
after insert on private.demo_seed_page_evidence
referencing new table as inserted_administrative_page_evidence
for each statement execute function private.demo_seed_refresh_administrative_page_evidence();

revoke all on function private.demo_seed_remove_administrative_evidence(text,uuid),
  private.demo_seed_apply_administrative_evidence(text,uuid),
  private.demo_seed_sync_administrative_evidence(),
  private.demo_seed_refresh_administrative_page_evidence()
from public,anon,authenticated,service_role;

revoke all on function public.get_administrative_evidence_desk(integer,text), public.save_poms_source(text,text,text,text), public.update_poms_source(uuid,timestamptz,text,text,text,text), public.authorize_poms_ingestion(uuid,text), public.complete_poms_ingestion(uuid,uuid,uuid,timestamptz,text,text,text,jsonb,text), public.reconcile_poms_ingestion_completion(uuid,uuid,uuid,timestamptz,text,text), public.add_poms_evidence(uuid,timestamptz,text,text,text), public.add_field_note_evidence(text,text,text,text,text,text), public.draft_field_note_packet(text,text), public.execute_administrative_object_action(text,uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.get_administrative_evidence_desk(integer,text), public.save_poms_source(text,text,text,text), public.update_poms_source(uuid,timestamptz,text,text,text,text), public.authorize_poms_ingestion(uuid,text), public.add_poms_evidence(uuid,timestamptz,text,text,text), public.add_field_note_evidence(text,text,text,text,text,text), public.draft_field_note_packet(text,text), public.execute_administrative_object_action(text,uuid,text,text) to authenticated;
grant execute on function public.complete_poms_ingestion(uuid,uuid,uuid,timestamptz,text,text,text,jsonb,text), public.reconcile_poms_ingestion_completion(uuid,uuid,uuid,timestamptz,text,text) to service_role;

notify pgrst, 'reload schema';
