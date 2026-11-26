-- CR-071 through CR-075: deterministic SAMPLE activation and deployed grant repair.
--
-- The migration itself creates no tenant, user, credential, or feature row.
-- SAMPLE data is written only through the service-role RPC after the existing
-- installation-bound lane guard accepts the pinned SAMPLE project.

set local lock_timeout = '5s';

-- Two real list windows for each backed knowledge surface.
insert into private.demo_seed_page_contract (surface, page_size, minimum_rows, scope, source)
values
  ('knowledgeStewardLibrary', 80, 160, 'organization', 'supabase/migrations/20260826151000_mi1_w2_feature_persistence.sql:2073'),
  ('knowledgeResourceCatalog', 80, 160, 'organization', 'supabase/migrations/20260826151000_mi1_w2_feature_persistence.sql:2441'),
  ('knowledgeIngestSources', 100, 200, 'organization', 'supabase/migrations/20260826151000_mi1_w2_feature_persistence.sql:1857')
on conflict (surface) do update
set page_size = excluded.page_size,
    minimum_rows = excluded.minimum_rows,
    scope = excluded.scope,
    source = excluded.source;

update private.demo_seed_function_catalog catalog
set coverage = 'seeded',
    evidence_key = evidence.evidence_key,
    gate_relation = null
from (values
  ('CR-071', 'knowledge-collections-revisions'),
  ('CR-072', 'knowledge-ingest-health'),
  ('CR-073', 'steward-file-library'),
  ('CR-074', 'protected-resource-catalog'),
  ('CR-075', 'google-drive-activation-surface')
) as evidence(function_id, evidence_key)
where catalog.function_id = evidence.function_id;

-- The compatibility list RPCs retain their original one-page signatures.
-- These explicit page endpoints make every seeded row reachable without
-- changing existing callers or creating ambiguous PostgREST overloads.
create function public.list_steward_library_files_page(
  p_query text,
  p_status text,
  p_category text,
  p_cursor_created_at timestamptz,
  p_cursor_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  needle text := nullif(pg_catalog.btrim(coalesce(p_query, '')), '');
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if needle is not null and pg_catalog.char_length(needle) > 120 then
    raise exception 'search is too long' using errcode = '22023';
  end if;
  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception 'invalid page cursor' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(private.mi1_w2_project_knowledge_file(file_page.id)
      order by file_page.created_at desc, file_page.id)
    from (
      select source.id, source.created_at
      from public.organization_knowledge_files source
      where source.organization_id = org
        and source.library = 'steward'
        and (p_status is null or source.review_status = p_status)
        and (p_category is null or source.category = p_category)
        and (
          needle is null
          or pg_catalog.strpos(pg_catalog.lower(source.title), pg_catalog.lower(needle)) > 0
          or pg_catalog.strpos(pg_catalog.lower(source.file_name), pg_catalog.lower(needle)) > 0
        )
        and (
          p_cursor_created_at is null
          or source.created_at < p_cursor_created_at
          or (source.created_at = p_cursor_created_at and source.id > p_cursor_id)
        )
      order by source.created_at desc, source.id
      limit 80
    ) file_page
  ), '[]'::jsonb);
end;
$function$;

create function public.list_resource_catalog_page(
  p_query text,
  p_category text,
  p_cursor_created_at timestamptz,
  p_cursor_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  needle text := nullif(pg_catalog.btrim(coalesce(p_query, '')), '');
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if needle is not null and pg_catalog.char_length(needle) > 120 then
    raise exception 'search is too long' using errcode = '22023';
  end if;
  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception 'invalid page cursor' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', catalog_page.id,
      'title', catalog_page.title,
      'summary', catalog_page.summary,
      'category', catalog_page.category,
      'fileName', catalog_page.file_name,
      'byteSize', catalog_page.byte_size,
      'createdAt', catalog_page.created_at
    ) order by catalog_page.created_at desc, catalog_page.id)
    from (
      select source.id, source.title, source.summary, source.category,
             source.file_name, source.byte_size, source.created_at
      from public.organization_knowledge_files source
      where source.organization_id = org
        and source.published_to_catalog
        and source.review_status = 'approved'
        and source.scan_status = 'clean'
        and (p_category is null or source.category = p_category)
        and (
          needle is null
          or pg_catalog.strpos(pg_catalog.lower(source.title), pg_catalog.lower(needle)) > 0
          or pg_catalog.strpos(pg_catalog.lower(source.summary), pg_catalog.lower(needle)) > 0
        )
        and (
          p_cursor_created_at is null
          or source.created_at < p_cursor_created_at
          or (source.created_at = p_cursor_created_at and source.id > p_cursor_id)
        )
      order by source.created_at desc, source.id
      limit 80
    ) catalog_page
  ), '[]'::jsonb);
end;
$function$;

create function public.list_knowledge_ingest_sources_page(
  p_cursor_created_at timestamptz,
  p_cursor_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception 'invalid page cursor' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', source_page.id,
      'fileId', source_page.file_id,
      'kind', source_page.source_kind,
      'label', source_page.label,
      'chunkCount', source_page.chunk_count,
      'embeddedCount', source_page.embedded_count,
      'health', source_page.health,
      'lastIngestAt', source_page.last_ingest_at,
      'lastError', source_page.last_error,
      'createdAt', source_page.created_at
    ) order by source_page.created_at desc, source_page.id)
    from (
      select source.*
      from public.organization_knowledge_sources source
      where source.organization_id = org
        and (
          p_cursor_created_at is null
          or source.created_at < p_cursor_created_at
          or (source.created_at = p_cursor_created_at and source.id > p_cursor_id)
        )
      order by source.created_at desc, source.id
      limit 100
    ) source_page
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_steward_library_files_page(text, text, text, timestamptz, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_resource_catalog_page(text, text, timestamptz, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_knowledge_ingest_sources_page(timestamptz, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_steward_library_files_page(text, text, text, timestamptz, uuid)
  to authenticated;
grant execute on function public.list_resource_catalog_page(text, text, timestamptz, uuid)
  to authenticated;
grant execute on function public.list_knowledge_ingest_sources_page(timestamptz, uuid)
  to authenticated;

create function private.demo_seed_apply_knowledge_library(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  chapter text;
  actor uuid := private.demo_seed_user(p_lane, p_run_id, 1);
  article_id uuid;
  collection_id uuid;
  file_id uuid;
  source_id uuid;
  body text := pg_catalog.rpad(
    'Union Ground fictional knowledge resource for protected SAMPLE verification.',
    128,
    ' '
  );
  ordinal integer;
  version_number integer;
begin
  if p_lane = 'presg' then
    if not exists (
      select 1 from private.presg_demo_runs run
      where run.id = p_run_id and run.state in ('applied', 'verified')
    ) then raise exception 'presg demo run is not applied'; end if;
    org := private.member_stress_uuid(p_run_id::text || ':presg:organization');
  elsif p_lane = 'uniondemo' then
    if not exists (
      select 1 from private.uniondemo_runs run
      where run.id = p_run_id and run.state in ('applied', 'verified')
    ) then raise exception 'union demo run is not applied'; end if;
    org := private.member_stress_uuid(p_run_id::text || ':ud:organization');
  else
    raise exception 'unknown demo lane';
  end if;
  if not exists (select 1 from public.organizations row where row.id = org and row.status = 'active') then
    raise exception 'demo organization is missing';
  end if;
  chapter := private.demo_seed_chapter(p_lane, p_run_id, 1);

  for ordinal in 1..12 loop
    article_id := private.member_stress_uuid(p_run_id::text || ':knowledge:article:' || ordinal);
    insert into public.member_kb_articles (
      id, slug, kind, title, article_ref, body, keywords, order_index,
      chapter_id, status, is_sample, version, created_by, updated_by,
      verified_by, verified_at, updated_at
    ) values (
      article_id,
      'knowledge-' || p_lane || '-' || pg_catalog.replace(p_run_id::text, '-', '') || '-' || ordinal,
      (array['contract', 'rights', 'faq'])[1 + ((ordinal - 1) % 3)],
      'Knowledge guide ' || pg_catalog.lpad(ordinal::text, 2, '0'),
      'Chapter knowledge · Guide ' || ordinal,
      'A realistic fictional guide with revision history for the SAMPLE knowledge workspace.',
      array['knowledge', 'workplace', 'guide']::text[],
      5000 + ordinal,
      chapter, 'published', false, 3, actor, actor, actor,
      pg_catalog.now() - interval '1 day', pg_catalog.now() - interval '1 day'
    ) on conflict (id) do update set
      title = excluded.title,
      article_ref = excluded.article_ref,
      body = excluded.body,
      status = excluded.status,
      version = excluded.version,
      updated_by = excluded.updated_by,
      verified_by = excluded.verified_by,
      verified_at = excluded.verified_at,
      updated_at = excluded.updated_at;

    for version_number in 1..3 loop
      insert into public.member_kb_article_revisions (
        article_id, chapter_id, version, status, kind, title, article_ref,
        body, keywords, changed_by, verified_by, verified_at, changed_at
      ) values (
        article_id, chapter, version_number,
        case when version_number = 1 then 'draft' else 'published' end,
        (array['contract', 'rights', 'faq'])[1 + ((ordinal - 1) % 3)],
        'Knowledge guide ' || pg_catalog.lpad(ordinal::text, 2, '0'),
        'Chapter knowledge · Guide ' || ordinal,
        'Revision ' || version_number || ' of a realistic fictional SAMPLE knowledge guide.',
        array['knowledge', 'workplace', 'guide']::text[], actor,
        case when version_number = 1 then null else actor end,
        case when version_number = 1 then null else pg_catalog.now() - ((4 - version_number) || ' days')::interval end,
        pg_catalog.now() - ((4 - version_number) || ' days')::interval
      ) on conflict on constraint member_kb_article_revisions_article_id_version_key do update set
        status = excluded.status,
        title = excluded.title,
        article_ref = excluded.article_ref,
        body = excluded.body,
        changed_by = excluded.changed_by,
        verified_by = excluded.verified_by,
        verified_at = excluded.verified_at,
        changed_at = excluded.changed_at;
    end loop;
  end loop;

  for ordinal in 1..200 loop
    file_id := private.member_stress_uuid(p_run_id::text || ':knowledge:file:' || ordinal);
    source_id := private.member_stress_uuid(p_run_id::text || ':knowledge:source:' || ordinal);
    insert into public.organization_knowledge_files (
      id, organization_id, chapter_id, library, title, summary, category,
      doc_type, file_name, mime_type, byte_size, content_sha256,
      storage_kind, storage_handle, storage_path, review_status, scan_status,
      index_status, visibility, published_to_catalog, idempotency_key,
      created_by, created_at, updated_at
    ) values (
      file_id, org, chapter, 'steward',
      'Knowledge resource ' || pg_catalog.lpad(ordinal::text, 3, '0'),
      'A protected fictional resource used to exercise catalog, download, and ingestion workflows.',
      (array['general', 'contract', 'forms', 'guides', 'health_safety', 'meetings', 'steward_tools', 'training'])[1 + ((ordinal - 1) % 8)],
      'guide', 'knowledge-resource-' || pg_catalog.lpad(ordinal::text, 3, '0') || '.txt',
      'text/plain', pg_catalog.octet_length(body),
      pg_catalog.encode(extensions.digest(pg_catalog.convert_to(body, 'UTF8'), 'sha256'), 'hex'),
      'organization_storage',
      private.member_stress_uuid(p_run_id::text || ':knowledge:handle:' || ordinal),
      'org/' || org::text || '/' || file_id::text || '/knowledge-resource-' || pg_catalog.lpad(ordinal::text, 3, '0') || '.txt',
      'approved', 'clean', 'chunked', 'organization', true,
      private.member_stress_uuid(p_run_id::text || ':knowledge:idempotency:' || ordinal),
      actor, pg_catalog.now() - (ordinal || ' hours')::interval,
      pg_catalog.now() - (ordinal || ' hours')::interval
    ) on conflict (id) do update set
      title = excluded.title,
      summary = excluded.summary,
      category = excluded.category,
      file_name = excluded.file_name,
      mime_type = excluded.mime_type,
      byte_size = excluded.byte_size,
      content_sha256 = excluded.content_sha256,
      storage_path = excluded.storage_path,
      review_status = excluded.review_status,
      scan_status = excluded.scan_status,
      index_status = excluded.index_status,
      visibility = excluded.visibility,
      published_to_catalog = excluded.published_to_catalog,
      updated_at = excluded.updated_at;

    insert into public.organization_knowledge_sources (
      id, organization_id, file_id, source_kind, label, doc_type,
      chunk_count, embedded_count, last_ingest_at, last_error, health,
      created_at, updated_at
    ) values (
      source_id, org, file_id, 'catalog_file',
      'Knowledge resource ' || pg_catalog.lpad(ordinal::text, 3, '0'),
      'guide', 2, 0, pg_catalog.now() - (ordinal || ' hours')::interval,
      null, 'unset_embedding', pg_catalog.now() - (ordinal || ' hours')::interval,
      pg_catalog.now() - (ordinal || ' hours')::interval
    ) on conflict (id) do update set
      label = excluded.label,
      chunk_count = excluded.chunk_count,
      embedded_count = excluded.embedded_count,
      last_ingest_at = excluded.last_ingest_at,
      last_error = excluded.last_error,
      health = excluded.health,
      updated_at = excluded.updated_at;

    insert into public.organization_knowledge_chunks (
      id, organization_id, source_id, chunk_index, content
    ) values
      (private.member_stress_uuid(p_run_id::text || ':knowledge:chunk:' || ordinal || ':0'), org, source_id, 0,
       'Workplace knowledge resource ' || ordinal || ', first deterministic chunk.'),
      (private.member_stress_uuid(p_run_id::text || ':knowledge:chunk:' || ordinal || ':1'), org, source_id, 1,
       'Workplace knowledge resource ' || ordinal || ', second deterministic chunk.')
    on conflict on constraint organization_knowledge_chunks_source_id_chunk_index_key
    do update set content = excluded.content;
  end loop;

  for ordinal in 1..20 loop
    collection_id := private.member_stress_uuid(p_run_id::text || ':knowledge:collection:' || ordinal);
    insert into public.knowledge_collections (
      id, organization_id, chapter_id, title, description, visibility,
      sort_order, created_by, updated_by
    ) values (
      collection_id, org, chapter,
      'Knowledge collection ' || pg_catalog.lpad(ordinal::text, 2, '0'),
      'A reusable fictional collection for the SAMPLE knowledge workspace.',
      case when ordinal % 4 = 0 then 'staff' else 'organization' end,
      ordinal * 10, actor, actor
    ) on conflict (id) do update set
      title = excluded.title,
      description = excluded.description,
      visibility = excluded.visibility,
      sort_order = excluded.sort_order,
      updated_by = excluded.updated_by,
      updated_at = pg_catalog.now();

    insert into public.knowledge_collection_items (
      id, organization_id, collection_id, item_kind, knowledge_file_id,
      sort_order, added_by
    )
    select
      private.member_stress_uuid(p_run_id::text || ':knowledge:collection-item:' || ordinal || ':' || item.n),
      org, collection_id, 'knowledge_file',
      private.member_stress_uuid(p_run_id::text || ':knowledge:file:' || (((ordinal - 1) * 10) + item.n)),
      item.n * 10, actor
    from pg_catalog.generate_series(1, 10) item(n)
    on conflict (id) do update set sort_order = excluded.sort_order;
  end loop;

  insert into private.demo_seed_function_evidence (
    lane, run_id, function_id, status, evidence_key
  ) values
    (p_lane, p_run_id, 'CR-071', 'seeded', 'knowledge-collections-revisions'),
    (p_lane, p_run_id, 'CR-072', 'seeded', 'knowledge-ingest-health'),
    (p_lane, p_run_id, 'CR-073', 'seeded', 'steward-file-library'),
    (p_lane, p_run_id, 'CR-074', 'seeded', 'protected-resource-catalog'),
    (p_lane, p_run_id, 'CR-075', 'seeded', 'google-drive-activation-surface')
  on conflict (lane, run_id, function_id) do update
  set status = excluded.status,
      evidence_key = excluded.evidence_key,
      recorded_at = pg_catalog.now();

  insert into private.demo_seed_page_evidence (lane, run_id, surface, actual_rows)
  values
    (p_lane, p_run_id, 'knowledgeStewardLibrary', 200),
    (p_lane, p_run_id, 'knowledgeResourceCatalog', 200),
    (p_lane, p_run_id, 'knowledgeIngestSources', 200)
  on conflict (lane, run_id, surface) do update
  set actual_rows = excluded.actual_rows,
      recorded_at = pg_catalog.now();

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'files', 200,
    'sources', 200,
    'collections', 20,
    'articles', 12,
    'objectNames', (
      select pg_catalog.jsonb_agg(file.storage_path order by file.storage_path)
      from public.organization_knowledge_files file
      where file.id in (
        select private.member_stress_uuid(p_run_id::text || ':knowledge:file:' || series.n)
        from pg_catalog.generate_series(1, 200) series(n)
      )
    )
  );
end;
$function$;

create function private.demo_seed_knowledge_library_status(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := case when p_lane = 'presg'
    then private.member_stress_uuid(p_run_id::text || ':presg:organization')
    when p_lane = 'uniondemo'
    then private.member_stress_uuid(p_run_id::text || ':ud:organization')
    else null end;
  files bigint;
  sources bigint;
  collections bigint;
  articles bigint;
  revisions bigint;
  objects bigint;
  evidence bigint;
  drive_unset boolean;
  drive_status text;
  activation_state text;
begin
  select pg_catalog.count(*) into files
  from public.organization_knowledge_files file
  where file.id in (
    select private.member_stress_uuid(p_run_id::text || ':knowledge:file:' || series.n)
    from pg_catalog.generate_series(1, 200) series(n)
  ) and file.organization_id = org and file.review_status = 'approved'
    and file.scan_status = 'clean' and file.published_to_catalog;
  select pg_catalog.count(*) into sources
  from public.organization_knowledge_sources source
  where source.id in (
    select private.member_stress_uuid(p_run_id::text || ':knowledge:source:' || series.n)
    from pg_catalog.generate_series(1, 200) series(n)
  ) and source.organization_id = org and source.chunk_count = 2;
  select pg_catalog.count(*) into collections
  from public.knowledge_collections collection
  where collection.id in (
    select private.member_stress_uuid(p_run_id::text || ':knowledge:collection:' || series.n)
    from pg_catalog.generate_series(1, 20) series(n)
  ) and collection.organization_id = org;
  select pg_catalog.count(*) into articles
  from public.member_kb_articles article
  where article.id in (
    select private.member_stress_uuid(p_run_id::text || ':knowledge:article:' || series.n)
    from pg_catalog.generate_series(1, 12) series(n)
  ) and article.chapter_id = private.demo_seed_chapter(p_lane, p_run_id, 1)
    and article.status = 'published' and not article.is_sample;
  select pg_catalog.count(*) into revisions
  from public.member_kb_article_revisions revision
  where revision.article_id in (
    select private.member_stress_uuid(p_run_id::text || ':knowledge:article:' || series.n)
    from pg_catalog.generate_series(1, 12) series(n)
  );
  select pg_catalog.count(*) into objects
  from storage.objects object
  where object.bucket_id = 'organization-knowledge'
    and object.name in (
      select file.storage_path from public.organization_knowledge_files file
      where file.id in (
        select private.member_stress_uuid(p_run_id::text || ':knowledge:file:' || series.n)
        from pg_catalog.generate_series(1, 200) series(n)
      )
    );
  select pg_catalog.count(*) into evidence
  from private.demo_seed_function_evidence evidence_row
  where evidence_row.lane = p_lane and evidence_row.run_id = p_run_id
    and evidence_row.function_id in ('CR-071', 'CR-072', 'CR-073', 'CR-074', 'CR-075')
    and evidence_row.status = 'seeded';
  select coalesce((
    select integration.status
    from public.organization_integrations integration
    where integration.organization_id = org and integration.provider = 'google_drive'
  ), 'unset') into drive_status;
  select not exists (
    select 1 from public.organization_integrations integration
    where integration.organization_id = org and integration.provider = 'google_drive'
      and (integration.status <> 'unset' or integration.credential_ref is not null)
  ) and not exists (
    select 1 from private.google_drive_oauth_states oauth_state
    where oauth_state.organization_id = org
      and oauth_state.expires_at > pg_catalog.now()
  ) into drive_unset;
  activation_state := case
    when files = 0 and sources = 0 and collections = 0 and articles = 0
      and revisions = 0 and objects = 0 and evidence = 0 then 'absent'
    when files = 200 and sources = 200 and collections = 20
      and articles = 12 and revisions = 36 and objects = 200
      and evidence = 5 and drive_unset then 'complete'
    else 'partial'
  end;
  return pg_catalog.jsonb_build_object(
    'ok', activation_state = 'complete',
    'activationState', activation_state,
    'files', files,
    'sources', sources,
    'collections', collections,
    'articles', articles,
    'revisions', revisions,
    'objects', objects,
    'evidence', evidence,
    'driveStatus', drive_status,
    'driveUnset', drive_unset,
    'outboundDeliveries', 0
  );
end;
$function$;

create function private.demo_seed_remove_knowledge_library(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  object_count bigint;
begin
  if p_lane not in ('presg', 'uniondemo') then raise exception 'unknown demo lane'; end if;
  select pg_catalog.count(*) into object_count
  from storage.objects object
  where object.bucket_id = 'organization-knowledge'
    and object.name in (
      select file.storage_path from public.organization_knowledge_files file
      where file.id in (
        select private.member_stress_uuid(p_run_id::text || ':knowledge:file:' || series.n)
        from pg_catalog.generate_series(1, 200) series(n)
      )
    );
  if object_count <> 0 then
    raise exception 'remove protected storage objects through the Storage API first';
  end if;
  delete from public.knowledge_collections collection
  where collection.id in (
    select private.member_stress_uuid(p_run_id::text || ':knowledge:collection:' || series.n)
    from pg_catalog.generate_series(1, 20) series(n)
  );
  delete from public.member_kb_article_revisions revision
  where revision.article_id in (
    select private.member_stress_uuid(p_run_id::text || ':knowledge:article:' || series.n)
    from pg_catalog.generate_series(1, 12) series(n)
  );
  delete from public.member_kb_articles article
  where article.id in (
    select private.member_stress_uuid(p_run_id::text || ':knowledge:article:' || series.n)
    from pg_catalog.generate_series(1, 12) series(n)
  );
  delete from public.organization_knowledge_files file
  where file.id in (
    select private.member_stress_uuid(p_run_id::text || ':knowledge:file:' || series.n)
    from pg_catalog.generate_series(1, 200) series(n)
  );
  delete from private.demo_seed_page_evidence evidence
  where evidence.lane = p_lane and evidence.run_id = p_run_id
    and evidence.surface in (
      'knowledgeStewardLibrary', 'knowledgeResourceCatalog', 'knowledgeIngestSources'
    );
  delete from private.demo_seed_function_evidence evidence
  where evidence.lane = p_lane and evidence.run_id = p_run_id
    and evidence.function_id in ('CR-071', 'CR-072', 'CR-073', 'CR-074', 'CR-075');
  return pg_catalog.jsonb_build_object('removed', true, 'lane', p_lane, 'runId', p_run_id);
end;
$function$;

create function public.activate_mi1_knowledge_sample(
  p_lane text,
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  if p_lane = 'presg' then
    perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  elsif p_lane = 'uniondemo' then
    perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  else
    raise exception 'unknown demo lane';
  end if;
  return private.demo_seed_apply_knowledge_library(p_lane, p_run_id);
end;
$function$;

create function public.mi1_knowledge_sample_status(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  return private.demo_seed_knowledge_library_status(p_lane, p_run_id);
end;
$function$;

create function public.remove_mi1_knowledge_sample(
  p_lane text,
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  if p_lane = 'presg' then
    perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  elsif p_lane = 'uniondemo' then
    perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  else
    raise exception 'unknown demo lane';
  end if;
  return private.demo_seed_remove_knowledge_library(p_lane, p_run_id);
end;
$function$;

-- Repair two adjacent migrations that revoked PUBLIC/anon but accidentally
-- left Supabase's default direct service_role EXECUTE grant in place. These
-- client RPCs remain reachable through authenticated only; backend jobs do not
-- call them.
do $grant_repair$
declare
  signature text;
begin
  foreach signature in array array[
    'public.casework_score_case(uuid, jsonb, uuid)',
    'public.casework_request_deadline_extension(uuid, timestamptz, text, uuid)',
    'public.casework_decide_deadline_extension(uuid, text, text)',
    'public.casework_advance_step(uuid, text, text, text, uuid)',
    'public.casework_acknowledge_alert(uuid, text)',
    'public.casework_set_restriction(uuid, boolean, text)',
    'public.casework_grant_access(uuid, uuid)',
    'public.casework_revoke_access(uuid)',
    'public.casework_save_intake_draft(uuid, text, uuid, uuid, jsonb, integer)',
    'public.casework_submit_retaliation_report(uuid, timestamptz, text, text, text, text, uuid)',
    'public.casework_withdraw_retaliation_report(uuid, text)',
    'public.casework_bulk_update_cases(uuid[], text, text, text, uuid)',
    'public.casework_create_checklist_template(text, text, text, text, jsonb)',
    'public.casework_set_checklist_item(uuid, boolean)',
    'public.casework_create_bargaining_workspace(text, text, timestamptz)',
    'public.casework_add_bargaining_proposal(uuid, text, text, text, timestamptz)',
    'public.casework_transition_bargaining_proposal(uuid, text, text, timestamptz)',
    'public.casework_add_bargaining_event(uuid, text, text, text)',
    'public.casework_set_bargaining_status(uuid, text, text)',
    'public.casework_log_management_behavior(uuid, text, text, text, timestamptz, text, text)',
    'public.casework_add_management_addendum(uuid, text)',
    'public.casework_link_cases(uuid, uuid, text, text)',
    'public.casework_set_reminder_status(uuid, text, timestamptz)',
    'public.casework_scan_retaliation_patterns(text)',
    'public.casework_review_retaliation_pattern(uuid, text, text, text)',
    'public.get_member_support_workspace()',
    'public.save_member_emergency_checklist(text, integer[], text, uuid)',
    'public.alert_member_emergency_steward(text, integer[], text, uuid)',
    'public.resolve_member_emergency_checklist(uuid, uuid)',
    'public.create_member_accommodation_request(text, text, uuid)',
    'public.transition_member_accommodation_request(uuid, text, text, uuid)',
    'public.record_member_hr_contact(uuid, text, text, text, text, timestamptz, date, uuid)',
    'public.save_organization_hr_directory(text, text, text, text, text, text, text, boolean, uuid)',
    'public.save_organization_onboarding_step(uuid, text, text, integer, boolean, uuid)',
    'public.start_member_onboarding_plan(uuid, uuid)',
    'public.complete_member_onboarding_step(uuid, uuid)',
    'public.create_member_mentorship_pair(uuid, uuid, date, uuid)',
    'public.transition_member_mentorship_pair(uuid, text, text, uuid)',
    'public.add_member_mentorship_note(uuid, text, uuid)',
    'public.save_member_mentorship_goal(uuid, uuid, text, boolean, uuid)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from service_role', signature);
  end loop;
end;
$grant_repair$;

revoke all on function private.demo_seed_apply_knowledge_library(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_knowledge_library_status(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_remove_knowledge_library(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.activate_mi1_knowledge_sample(text, uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.mi1_knowledge_sample_status(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.remove_mi1_knowledge_sample(text, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.activate_mi1_knowledge_sample(text, uuid, text, text)
  to service_role;
grant execute on function public.mi1_knowledge_sample_status(text, uuid)
  to service_role;
grant execute on function public.remove_mi1_knowledge_sample(text, uuid, text, text)
  to service_role;

comment on function public.activate_mi1_knowledge_sample(text, uuid, text, text) is
  'Service-role-only, installation-bound SAMPLE activation for CR-071 through CR-075; creates no tenant, user, provider credential, or outbound delivery.';
comment on function public.mi1_knowledge_sample_status(text, uuid) is
  'Service-role-only exact-count status for the reversible CR-071 through CR-075 SAMPLE activation.';
comment on function public.remove_mi1_knowledge_sample(text, uuid, text, text) is
  'Service-role-only exact-run cleanup for CR-071 through CR-075 after protected objects are removed through the Storage API.';
