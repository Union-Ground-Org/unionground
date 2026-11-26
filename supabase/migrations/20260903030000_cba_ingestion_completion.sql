-- MI1 CR-069: organization-specific CBA normalization into chapter drafts.
--
-- Contract uploads use the existing protected organization library. The API
-- extracts and normalizes explicit ARTICLE/SECTION headings; this migration
-- gives that service completion one tenant-checked write path into the
-- existing review/version/publication/search model. Imported rows are drafts:
-- a staff member must review and explicitly verify them before Compass can
-- retrieve them. No provider credential, tenant, or agreement is seeded.

set local lock_timeout = '5s';

-- Keep the bounded audit envelope exact while admitting the aggregate-only
-- reconciliation counters below. No agreement text or heading is logged.
alter table public.organization_audit_events
  drop constraint organization_audit_events_metadata_keys;

alter table public.organization_audit_events
  add constraint organization_audit_events_metadata_keys check (
    metadata - array[
      'organizationId', 'chapterId', 'slug', 'name', 'role', 'userId',
      'status', 'requireStaffMfa', 'questionId', 'replyId', 'targetKind',
      'voted', 'kind', 'surface', 'exportFormat', 'rowCount', 'suppressedCount',
      'expiresAt', 'grade', 'stepNumber', 'effectiveOn', 'action', 'provider',
      'host', 'events', 'entityType', 'entityId', 'fromStatus', 'toStatus',
      'fromRole', 'toRole', 'eventType', 'domain', 'jobName', 'runId',
      'remediation', 'outcome', 'count', 'fieldsChanged', 'reasonCode',
      'exportType', 'cadence', 'surveyId', 'sessionId', 'privacyMinResponses',
      'caseId', 'fromStep', 'toStep', 'previousDeadline', 'newDeadline',
      'alertId', 'reminderId', 'restricted', 'fileId', 'sourceId', 'category',
      'library', 'reviewStatus', 'indexStatus', 'byteSize', 'handoffId',
      'fromStewardId', 'toStewardId', 'clauseId', 'article',
      'collectionId', 'visibility', 'scope', 'itemKind', 'itemId', 'included',
      'articleId', 'restoredRevisionId', 'restoredFromVersion', 'newVersion',
      'accountEmail', 'fields', 'version', 'campaignId', 'batchId',
      'scopeKind', 'eligibleCount', 'amountCents', 'obligationId',
      'receiptNumber', 'eventKind', 'channel', 'attemptId', 'selectedHat',
      'requestedBy', 'reservationId', 'resolution', 'evidenceReference',
      'reason', 'failureClass', 'publishedPreserved',
      'publishedCandidatesStaged', 'publishedRetirementsStaged',
      'staleCandidatesCleared', 'draftsRetired'
    ] = '{}'::jsonb
  );

alter table public.member_kb_articles
  add column knowledge_source_id uuid
    references public.organization_knowledge_sources(id) on delete restrict,
  add column import_key text;

alter table public.member_kb_articles
  add constraint member_kb_articles_import_key_bounded
    check (import_key is null or pg_catalog.char_length(import_key) between 32 and 64),
  add constraint member_kb_articles_import_provenance_complete
    check ((knowledge_source_id is null) = (import_key is null));

create unique index member_kb_articles_chapter_import_key
  on public.member_kb_articles (chapter_id, import_key)
  where knowledge_source_id is not null;

create index member_kb_articles_source_status_idx
  on public.member_kb_articles (knowledge_source_id, status)
  where knowledge_source_id is not null;

-- Preserve verified/published language while placing changed imports in the
-- existing staff revision queue. Canonical history remains unique by version;
-- the single import candidate occupies version zero until a reviewer restores
-- it as a positive-version draft through the established workflow.
alter table public.member_kb_article_revisions
  add column import_candidate_key text,
  add column knowledge_source_id uuid
    references public.organization_knowledge_sources(id) on delete restrict,
  drop constraint member_kb_article_revisions_version_check,
  add constraint member_kb_article_revisions_version_shape check (
    (import_candidate_key is null and version > 0)
    or (import_candidate_key is not null and version = 0)
  ),
  add constraint member_kb_article_revisions_import_candidate_key_bounded
    check (import_candidate_key is null or import_candidate_key ~ '^[0-9a-f]{32}$'),
  add constraint member_kb_article_revisions_import_candidate_complete
    check ((import_candidate_key is null) = (knowledge_source_id is null)),
  add constraint member_kb_article_revisions_import_candidate_unique
    unique (article_id, import_candidate_key);

-- Contract uploads need an explicit chapter before the protected object is
-- reserved. Organization-wide staff can choose any chapter in their tenant;
-- chapter-scoped staff remain confined to their currently selected chapter.
-- The old signature is removed so PostgREST cannot select an overload that
-- silently drops the chapter choice.
drop function if exists public.prepare_steward_library_upload(text, bigint, text, text, text, text, uuid);

create function public.prepare_steward_library_upload(
  p_file_name text,
  p_byte_size bigint,
  p_content_sha256 text,
  p_title text,
  p_summary text,
  p_category text,
  p_idempotency_key uuid,
  p_chapter_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  actor_chapter text := private.current_member_chapter();
  safe_name text := private.mi1_w2_safe_file_name(p_file_name);
  actor_id uuid := (select auth.uid());
  requested_category text := coalesce(nullif(pg_catalog.btrim(p_category), ''), 'general');
  selected_chapter text := nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), '');
  target_chapter text;
  cached jsonb;
  cached_request jsonb;
  request_payload jsonb;
  created uuid;
  handle uuid;
  result jsonb;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if requested_category = 'contract' then
    target_chapter := selected_chapter;
    if target_chapter is null then
      raise exception 'active organization chapter required for contract upload' using errcode = '42501';
    end if;
    if not private.mi1_w2_same_org_chapter(org, target_chapter) then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  elsif actor_chapter is not null and private.mi1_w2_same_org_chapter(org, actor_chapter) then
    target_chapter := actor_chapter;
  end if;
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > 10485760 then
    raise exception 'file size is outside the allowed range' using errcode = '22023';
  end if;
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  request_payload := pg_catalog.jsonb_build_object(
    'fileName', safe_name,
    'byteSize', p_byte_size,
    'contentSha256', coalesce(p_content_sha256, ''),
    'title', coalesce(pg_catalog.btrim(p_title), ''),
    'summary', coalesce(pg_catalog.btrim(p_summary), ''),
    'category', requested_category,
    'chapterId', target_chapter
  );
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'prepare_steward_library_upload:' || org::text || ':' || actor_id::text || ':' || p_idempotency_key::text, 509
  ));
  select receipt.result, receipt.request_payload into cached, cached_request
  from private.mi1_w2_operation_receipts receipt
  where receipt.organization_id = org
    and receipt.operation = 'prepare_steward_library_upload'
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if cached_request is distinct from request_payload then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    return cached;
  end if;
  insert into public.organization_knowledge_files (
    organization_id, chapter_id, library, title, summary, category, file_name,
    byte_size, content_sha256, storage_path, idempotency_key, created_by
  ) values (
    org, target_chapter, 'steward',
    coalesce(nullif(pg_catalog.btrim(coalesce(p_title, '')), ''), safe_name),
    pg_catalog.btrim(coalesce(p_summary, '')), requested_category,
    safe_name, p_byte_size, nullif(p_content_sha256, ''), 'pending',
    p_idempotency_key, actor_id
  ) returning id, storage_handle into created, handle;
  update public.organization_knowledge_files
  set storage_path = 'org/' || org::text || '/' || created::text || '/' || safe_name
  where id = created;
  perform private.mi1_w2_write_audit(org, 'knowledge_file_uploaded', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', target_chapter, 'fileId', created,
    'library', 'steward', 'category', requested_category,
    'reviewStatus', 'pending_scan', 'byteSize', p_byte_size, 'action', 'uploaded'
  ));
  result := pg_catalog.jsonb_build_object(
    'uploadId', created, 'fileId', created, 'storageHandle', handle,
    'chapterId', target_chapter
  );
  insert into private.mi1_w2_operation_receipts (
    organization_id, operation, idempotency_key, request_payload, result
  ) values (org, 'prepare_steward_library_upload', p_idempotency_key, request_payload, result);
  return result;
end;
$function$;

revoke all on function public.prepare_steward_library_upload(
  text, bigint, text, text, text, text, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.prepare_steward_library_upload(
  text, bigint, text, text, text, text, uuid, text
) to authenticated;

create function public.list_knowledge_upload_chapters()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
begin
  if not private.mfa_satisfied()
     or not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', chapter.id, 'name', chapter.name
    ) order by chapter.order_index, chapter.name, chapter.id)
    from public.chapters chapter
    where chapter.organization_id = org
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_knowledge_upload_chapters()
  from public, anon, authenticated, service_role;
grant execute on function public.list_knowledge_upload_chapters()
  to authenticated;

-- Revision review must follow the explicitly selected contract chapter rather
-- than the reviewer's current member chapter. Walk this keyset page from the
-- authenticated client so every imported draft remains reachable even in an
-- established knowledge library.
create function public.list_knowledge_review_articles_page(
  p_chapter_id text,
  p_cursor_order_index integer,
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
  target_chapter text := nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), '');
begin
  if not private.mfa_satisfied()
     or not private.mi1_knowledge_collection_staff(org)
     or target_chapter is null
     or not private.mi1_w2_same_org_chapter(org, target_chapter) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if (p_cursor_order_index is null) <> (p_cursor_id is null) then
    raise exception 'invalid page cursor' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', article.id,
      'chapterId', article.chapter_id,
      'title', article.title,
      'articleRef', article.article_ref,
      'status', article.status,
      'version', article.version,
      'orderIndex', article.order_index
    ) order by article.order_index, article.id)
    from (
      select source.*
      from public.member_kb_articles source
      where source.chapter_id = target_chapter
        and not source.is_sample
        and (
          p_cursor_order_index is null
          or (source.order_index, source.id) > (p_cursor_order_index, p_cursor_id)
        )
      order by source.order_index, source.id
      limit 500
    ) article
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_knowledge_review_articles_page(text, integer, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_knowledge_review_articles_page(text, integer, uuid)
  to authenticated;

create or replace function public.authorize_knowledge_ingest(p_source_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  actor uuid := (select auth.uid());
  source public.organization_knowledge_sources%rowtype;
  file public.organization_knowledge_files%rowtype;
  recent_count integer;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  select * into source from public.organization_knowledge_sources row
  where row.id = p_source_id and row.organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  select * into file from public.organization_knowledge_files row
  where row.id = source.file_id and row.organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if not private.has_organization_role(org, array['advisor', 'admin', 'vp'])
     and not (
       file.created_by = actor
       and file.scan_status = 'pending' and file.index_status = 'pending'
     ) then raise exception 'not authorized' using errcode = '42501'; end if;
  if file.category = 'contract' and (
    file.chapter_id is null
    or not exists (
      select 1 from public.chapters chapter
      where chapter.id = file.chapter_id and chapter.organization_id = org
    )
  ) then raise exception 'active organization chapter required for contract ingestion' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'authorize_knowledge_ingest:' || org::text || ':' || actor::text, 509
  ));
  select pg_catalog.count(*) into recent_count
  from public.organization_audit_events event
  where event.organization_id = org
    and event.actor_user_id = actor
    and event.event_type = 'knowledge_ingest_authorized'
    and event.created_at >= pg_catalog.now() - interval '1 hour';
  if recent_count >= 20 then
    return pg_catalog.jsonb_build_object('rateLimited', true);
  end if;
  perform private.mi1_w2_write_audit(org, 'knowledge_ingest_authorized', pg_catalog.jsonb_build_object(
    'organizationId', org, 'fileId', file.id, 'sourceId', source.id, 'action', 'ingest'
  ));
  return pg_catalog.jsonb_build_object(
    'organizationId', org, 'sourceId', source.id, 'fileId', file.id,
    'bucketId', 'organization-knowledge', 'objectName', file.storage_path,
    'fileName', file.file_name, 'mimeType', file.mime_type,
    'byteSize', file.byte_size, 'contentSha256', file.content_sha256,
    'category', file.category, 'chapterId', file.chapter_id,
    'actorUserId', actor, 'rateLimited', false
  );
end;
$function$;

create or replace function public.replace_cba_knowledge_drafts(
  p_organization_id uuid,
  p_source_id uuid,
  p_actor_user_id uuid,
  p_chapter_id text,
  p_articles jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  source public.organization_knowledge_sources%rowtype;
  source_file public.organization_knowledge_files%rowtype;
  item record;
  target_article_id uuid;
  clean_ref text;
  clean_title text;
  clean_body text;
  clean_clause_key text;
  clean_keywords text[];
  item_key text;
  incoming_keys text[] := '{}'::text[];
  imported_count integer := 0;
  preserved_count integer := 0;
  staged_count integer := 0;
  cleared_candidate_count integer := 0;
  retired_draft_count integer := 0;
  retirement_staged_count integer := 0;
  candidate_key text;
  current_article public.member_kb_articles%rowtype;
  base_order integer;
  lineage_end integer;
  lineage_count integer;
  lineage_growth integer;
begin
  if (select auth.role()) <> 'service_role'
     or p_organization_id is null or p_source_id is null
     or p_actor_user_id is null or p_chapter_id is null
     or pg_catalog.jsonb_typeof(coalesce(p_articles, '[]'::jsonb)) <> 'array'
     or pg_catalog.jsonb_array_length(coalesce(p_articles, '[]'::jsonb)) not between 1 and 300 then
    raise exception 'invalid cba completion' using errcode = '22023';
  end if;

  select * into source from public.organization_knowledge_sources row
  where row.id = p_source_id and row.organization_id = p_organization_id
  for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  select * into source_file from public.organization_knowledge_files row
  where row.id = source.file_id and row.organization_id = p_organization_id;
  if not found or source_file.category <> 'contract' then
    raise exception 'contract source required' using errcode = '22023';
  end if;
  if source_file.chapter_id is null
     or source_file.chapter_id is distinct from p_chapter_id
     or not exists (
    select 1 from public.chapters chapter
    where chapter.id = p_chapter_id and chapter.organization_id = p_organization_id
  ) or not exists (
    select 1
    from public.organization_memberships membership
    join public.organization_role_grants role
      on role.organization_id = membership.organization_id and role.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id = p_actor_user_id and membership.status = 'active'
      and role.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  ) then raise exception 'not authorized' using errcode = '42501'; end if;

  -- Only one replacement agreement may reconcile a chapter lineage at a
  -- time. The chapter/import-key unique index remains the final invariant if
  -- a future writer does not participate in this lock.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'replace_cba_knowledge_drafts:' || p_organization_id::text || ':' || p_chapter_id, 509
  ));

  -- Reuse the imported agreement's existing order range on successor
  -- uploads. Falling back to the chapter maximum is only for the first
  -- agreement, so an inserted heading can take its true source position
  -- instead of being appended after the old lineage.
  select pg_catalog.min(article.order_index) - 1,
         pg_catalog.max(article.order_index)
    into base_order, lineage_end
  from public.member_kb_articles article
  join public.organization_knowledge_sources prior_source
    on prior_source.id = article.knowledge_source_id
    and prior_source.organization_id = p_organization_id
  join public.organization_knowledge_files prior_file
    on prior_file.id = prior_source.file_id
    and prior_file.organization_id = p_organization_id
    and prior_file.chapter_id = p_chapter_id
    and prior_file.category = 'contract'
  where article.chapter_id = p_chapter_id;
  if base_order is null then
    select coalesce(pg_catalog.max(article.order_index), 0) into base_order
    from public.member_kb_articles article where article.chapter_id = p_chapter_id;
    lineage_end := base_order;
  end if;

  for item in
    select value, ordinality
    from pg_catalog.jsonb_array_elements(p_articles) with ordinality
  loop
    clean_ref := pg_catalog.btrim(coalesce(item.value ->> 'articleRef', ''));
    clean_title := pg_catalog.btrim(coalesce(item.value ->> 'title', ''));
    clean_body := pg_catalog.btrim(coalesce(item.value ->> 'body', ''));
    clean_clause_key := pg_catalog.lower(pg_catalog.btrim(coalesce(item.value ->> 'clauseKey', '')));
    select coalesce(pg_catalog.array_agg(keyword order by keyword), '{}'::text[])
      into clean_keywords
    from (
      select distinct pg_catalog.btrim(value) as keyword
      from pg_catalog.jsonb_array_elements_text(coalesce(item.value -> 'keywords', '[]'::jsonb)) entry(value)
      where pg_catalog.btrim(value) <> ''
      limit 30
    ) normalized;
    if pg_catalog.char_length(clean_ref) not between 1 and 120
       or pg_catalog.char_length(clean_title) not between 1 and 200
       or pg_catalog.char_length(clean_body) not between 1 and 100000
       or pg_catalog.char_length(clean_clause_key) not between 1 and 160
       or clean_clause_key !~ '^(article:[a-z0-9]+([.-][a-z0-9]+)*(/section:[a-z0-9]+([.-][a-z0-9]+)*)?|section:[a-z0-9]+([.-][a-z0-9]+)*|agreement:root)$'
       or exists (
         select 1 from pg_catalog.unnest(clean_keywords) keyword
         where pg_catalog.char_length(keyword) > 80
       ) then raise exception 'invalid cba article' using errcode = '22023'; end if;
    -- The explicit heading identifier is stable when a predecessor inserts or
    -- removes another clause. Human-readable title/reference remain reviewable
    -- content and therefore do not participate in the key.
    item_key := pg_catalog.md5('clause:' || clean_clause_key);
    if item_key = any(incoming_keys) then
      raise exception 'duplicate cba clause key' using errcode = '22023';
    end if;
    incoming_keys := pg_catalog.array_append(incoming_keys, item_key);
    -- One chapter has one active imported-agreement lineage. A replacement
    -- upload receives a fresh source id, so reconcile by chapter + stable
    -- clause key across every protected contract source in that lineage.
    select article.* into current_article
    from public.member_kb_articles article
    join public.organization_knowledge_sources prior_source
      on prior_source.id = article.knowledge_source_id
      and prior_source.organization_id = p_organization_id
    join public.organization_knowledge_files prior_file
      on prior_file.id = prior_source.file_id
      and prior_file.organization_id = p_organization_id
      and prior_file.chapter_id = p_chapter_id
      and prior_file.category = 'contract'
    where article.import_key = item_key
      and article.chapter_id = p_chapter_id
    order by (article.knowledge_source_id = p_source_id) desc, article.updated_at desc
    limit 1
    for update of article;
    if found then
      target_article_id := current_article.id;
      if current_article.status = 'published' then
        -- Ordering is agreement structure, not verified clause content. Keep
        -- the published body/version intact while placing every matched row
        -- at its incoming sequence position.
        update public.member_kb_articles article
        set order_index = base_order + item.ordinality
        where article.id = current_article.id
          and article.order_index is distinct from base_order + item.ordinality;
        preserved_count := preserved_count + 1;
        if current_article.title is distinct from clean_title
           or current_article.article_ref is distinct from clean_ref
           or current_article.body is distinct from clean_body
           or current_article.keywords is distinct from clean_keywords then
          candidate_key := pg_catalog.md5(
            clean_ref || E'\n' || clean_title || E'\n' || clean_body || E'\n'
            || pg_catalog.array_to_string(clean_keywords, E'\n')
          );
          insert into public.member_kb_article_revisions (
            article_id, chapter_id, version, status, kind, title, article_ref,
            body, keywords, changed_by, verified_by, verified_at,
            import_candidate_key, knowledge_source_id
          ) values (
            current_article.id, current_article.chapter_id, 0,
            'draft', current_article.kind, clean_title, clean_ref, clean_body,
            clean_keywords, p_actor_user_id, null, null, candidate_key, p_source_id
          ) on conflict (article_id, version) do update set
            status = excluded.status,
            title = excluded.title,
            article_ref = excluded.article_ref,
            body = excluded.body,
            keywords = excluded.keywords,
            changed_by = excluded.changed_by,
            import_candidate_key = excluded.import_candidate_key,
            knowledge_source_id = excluded.knowledge_source_id,
            changed_at = pg_catalog.now();
          staged_count := staged_count + 1;
        else
          -- A successful retry that matches the verified canonical row makes
          -- any older changed/removal candidate stale.
          delete from public.member_kb_article_revisions revision
          where revision.article_id = current_article.id
            and revision.version = 0
            and revision.import_candidate_key is not null;
          if found then
            cleared_candidate_count := cleared_candidate_count + 1;
          end if;
        end if;
        continue;
      end if;
      if current_article.status = 'draft'
         and current_article.title is not distinct from clean_title
         and current_article.article_ref is not distinct from clean_ref
         and current_article.body is not distinct from clean_body
         and current_article.keywords is not distinct from clean_keywords then
        -- A retry of identical draft content is not a new version. It may
        -- still move because a predecessor heading was inserted or removed.
        update public.member_kb_articles article
        set order_index = base_order + item.ordinality
        where article.id = current_article.id
          and article.order_index is distinct from base_order + item.ordinality;
        continue;
      end if;
      update public.member_kb_articles
      set title = clean_title, article_ref = clean_ref, body = clean_body,
          keywords = clean_keywords, order_index = base_order + item.ordinality,
          status = 'draft', version = version + 1,
          knowledge_source_id = p_source_id,
          updated_by = p_actor_user_id, verified_by = null, verified_at = null,
          updated_at = pg_catalog.now()
      where id = target_article_id;
    else
      target_article_id := extensions.gen_random_uuid();
      insert into public.member_kb_articles (
        id, slug, kind, title, article_ref, body, keywords, order_index,
        chapter_id, status, is_sample, version, created_by, updated_by,
        verified_by, verified_at, updated_at, knowledge_source_id, import_key
      ) values (
        target_article_id,
        'cba-' || pg_catalog.replace(p_source_id::text, '-', '') || '-' || pg_catalog.substr(item_key, 1, 16),
        'contract', clean_title, clean_ref, clean_body, clean_keywords,
        base_order + item.ordinality, p_chapter_id, 'draft', false, 1,
        p_actor_user_id, p_actor_user_id, null, null, pg_catalog.now(),
        p_source_id, item_key
      );
    end if;
    insert into public.member_kb_article_revisions (
      article_id, chapter_id, version, status, kind, title, article_ref,
      body, keywords, changed_by, verified_by, verified_at
    ) select
      article.id, article.chapter_id, article.version, article.status,
      article.kind, article.title, article.article_ref, article.body,
      article.keywords, p_actor_user_id, article.verified_by, article.verified_at
    from public.member_kb_articles article where article.id = target_article_id;
    imported_count := imported_count + 1;
  end loop;

  with retired as (
    update public.member_kb_articles article
    set status = 'retired', version = article.version + 1,
        updated_by = p_actor_user_id, verified_by = null, verified_at = null,
        updated_at = pg_catalog.now()
    where article.chapter_id = p_chapter_id
      and article.status = 'draft'
      and article.knowledge_source_id is not null
      and exists (
        select 1
        from public.organization_knowledge_sources prior_source
        join public.organization_knowledge_files prior_file
          on prior_file.id = prior_source.file_id
          and prior_file.organization_id = p_organization_id
          and prior_file.chapter_id = p_chapter_id
          and prior_file.category = 'contract'
        where prior_source.id = article.knowledge_source_id
          and prior_source.organization_id = p_organization_id
      )
      and not (article.import_key = any(incoming_keys))
    returning article.*
  )
  insert into public.member_kb_article_revisions (
    article_id, chapter_id, version, status, kind, title, article_ref,
    body, keywords, changed_by, verified_by, verified_at
  ) select
    article.id, article.chapter_id, article.version, article.status,
    article.kind, article.title, article.article_ref, article.body,
    article.keywords, p_actor_user_id, article.verified_by, article.verified_at
  from retired article;

  get diagnostics retired_draft_count = row_count;

  -- A missing verified clause is never deleted or retired by ingestion. Stage
  -- an explicit version-zero retirement candidate so an authorized reviewer
  -- can either keep the canonical publication or confirm retirement.
  for current_article in
    select article.*
    from public.member_kb_articles article
    join public.organization_knowledge_sources prior_source
      on prior_source.id = article.knowledge_source_id
      and prior_source.organization_id = p_organization_id
    join public.organization_knowledge_files prior_file
      on prior_file.id = prior_source.file_id
      and prior_file.organization_id = p_organization_id
      and prior_file.chapter_id = p_chapter_id
      and prior_file.category = 'contract'
    where article.chapter_id = p_chapter_id
      and article.status = 'published'
      and not (article.import_key = any(incoming_keys))
    order by article.order_index, article.id
    for update of article
  loop
    candidate_key := pg_catalog.md5(
      'retire:' || p_source_id::text || ':' || current_article.import_key
    );
    insert into public.member_kb_article_revisions (
      article_id, chapter_id, version, status, kind, title, article_ref,
      body, keywords, changed_by, verified_by, verified_at,
      import_candidate_key, knowledge_source_id
    ) values (
      current_article.id, current_article.chapter_id, 0,
      'retired', current_article.kind, current_article.title,
      current_article.article_ref, current_article.body,
      current_article.keywords, p_actor_user_id, null, null,
      candidate_key, p_source_id
    ) on conflict (article_id, version) do update set
      status = excluded.status,
      kind = excluded.kind,
      title = excluded.title,
      article_ref = excluded.article_ref,
      body = excluded.body,
      keywords = excluded.keywords,
      changed_by = excluded.changed_by,
      verified_by = null,
      verified_at = null,
      import_candidate_key = excluded.import_candidate_key,
      knowledge_source_id = excluded.knowledge_source_id,
      changed_at = pg_catalog.now();
    retirement_staged_count := retirement_staged_count + 1;
  end loop;

  -- Keep the agreement contiguous without consuming order indexes held by
  -- independently authored knowledge. A successor can add clauses after
  -- another article was appended; expand the old lineage range first, then
  -- place clauses omitted from the successor after the incoming sequence so
  -- their explicit keep/retire decision remains inspectable without ties.
  select pg_catalog.count(*)::integer into lineage_count
  from public.member_kb_articles article
  join public.organization_knowledge_sources prior_source
    on prior_source.id = article.knowledge_source_id
    and prior_source.organization_id = p_organization_id
  join public.organization_knowledge_files prior_file
    on prior_file.id = prior_source.file_id
    and prior_file.organization_id = p_organization_id
    and prior_file.chapter_id = p_chapter_id
    and prior_file.category = 'contract'
  where article.chapter_id = p_chapter_id;

  lineage_growth := base_order + lineage_count - lineage_end;
  if lineage_growth < 0 then lineage_growth := 0; end if;
  if lineage_growth > 0 then
    update public.member_kb_articles article
    set order_index = article.order_index + lineage_growth
    where article.chapter_id = p_chapter_id
      and article.order_index > lineage_end
      and not exists (
        select 1
        from public.organization_knowledge_sources prior_source
        join public.organization_knowledge_files prior_file
          on prior_file.id = prior_source.file_id
          and prior_file.organization_id = p_organization_id
          and prior_file.chapter_id = p_chapter_id
          and prior_file.category = 'contract'
        where prior_source.id = article.knowledge_source_id
          and prior_source.organization_id = p_organization_id
      );
  end if;

  with omitted as (
    select article.id,
           pg_catalog.row_number() over (order by article.order_index, article.id)::integer as position_offset
    from public.member_kb_articles article
    join public.organization_knowledge_sources prior_source
      on prior_source.id = article.knowledge_source_id
      and prior_source.organization_id = p_organization_id
    join public.organization_knowledge_files prior_file
      on prior_file.id = prior_source.file_id
      and prior_file.organization_id = p_organization_id
      and prior_file.chapter_id = p_chapter_id
      and prior_file.category = 'contract'
    where article.chapter_id = p_chapter_id
      and not (article.import_key = any(incoming_keys))
  )
  update public.member_kb_articles article
  set order_index = base_order + pg_catalog.cardinality(incoming_keys) + omitted.position_offset
  from omitted
  where article.id = omitted.id;

  insert into public.organization_audit_events (
    organization_id, event_type, actor_user_id, idempotency_key, metadata
  ) values (
    p_organization_id, 'knowledge_source_retried', p_actor_user_id,
    extensions.gen_random_uuid(), pg_catalog.jsonb_build_object(
      'organizationId', p_organization_id, 'chapterId', p_chapter_id,
      'fileId', source.file_id, 'sourceId', p_source_id,
      'action', 'cba_normalized', 'count', imported_count,
      'publishedPreserved', preserved_count,
      'publishedCandidatesStaged', staged_count,
      'publishedRetirementsStaged', retirement_staged_count,
      'staleCandidatesCleared', cleared_candidate_count,
      'draftsRetired', retired_draft_count
    )
  );
  return pg_catalog.jsonb_build_object(
    'sourceId', p_source_id,
    'articleCount', imported_count,
    'preservedPublishedCount', preserved_count,
    'stagedPublishedCount', staged_count,
    'stagedRetirementCount', retirement_staged_count,
    'clearedCandidateCount', cleared_candidate_count,
    'retiredDraftCount', retired_draft_count,
    'status', 'draft_review_required'
  );
end;
$function$;

revoke all on function public.replace_cba_knowledge_drafts(uuid, uuid, uuid, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.replace_cba_knowledge_drafts(uuid, uuid, uuid, text, jsonb)
  to service_role;

comment on column public.member_kb_articles.knowledge_source_id is
  'Protected organization knowledge source that produced this reviewable CBA draft; NULL for authored content.';
comment on function public.replace_cba_knowledge_drafts(uuid, uuid, uuid, text, jsonb) is
  'Service-only tenant/chapter checked reconciliation of normalized contract clauses into review-required KB drafts.';

-- Extend the existing revision workflow to consume import candidates. Changed
-- clauses become drafts for ordinary editorial review. Missing verified clauses
-- can be explicitly kept (candidate dismissed) or retired (new immutable
-- version); ingestion itself never makes that publication decision.
drop function if exists public.restore_chapter_kb_revision(uuid, bigint, boolean, uuid);

create function public.restore_chapter_kb_revision(
  p_article_id uuid,
  p_revision_id bigint,
  p_confirm_verified boolean,
  p_idempotency_key uuid,
  p_chapter_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  requested_chapter text := nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), '');
  chapter text := coalesce(requested_chapter, private.current_member_chapter());
  actor uuid := (select auth.uid());
  article public.member_kb_articles%rowtype;
  revision public.member_kb_article_revisions%rowtype;
  restored public.member_kb_articles%rowtype;
  next_status text;
  request_payload jsonb := pg_catalog.jsonb_build_object(
    'articleId', p_article_id, 'revisionId', p_revision_id,
    'confirmVerified', coalesce(p_confirm_verified, false)
  ) || case when requested_chapter is null then '{}'::jsonb
            else pg_catalog.jsonb_build_object('chapterId', chapter) end;
  cached jsonb;
  cached_request jsonb;
begin
  if not private.mfa_satisfied()
     or not private.mi1_knowledge_collection_staff(org)
     or chapter is null
     or not private.mi1_w2_same_org_chapter(org, chapter)
     or p_idempotency_key is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'restore_chapter_kb_revision:' || org::text || ':' || actor::text || ':' || p_idempotency_key::text, 509
  ));
  select receipt.result, receipt.request_payload into cached, cached_request
  from private.mi1_w2_operation_receipts receipt
  where receipt.organization_id = org
    and receipt.operation = 'restore_chapter_kb_revision'
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if cached_request is distinct from request_payload then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    return cached;
  end if;
  select * into article from public.member_kb_articles source
  where source.id = p_article_id and source.chapter_id = chapter and not source.is_sample
  for update;
  select * into revision from public.member_kb_article_revisions source
  where source.id = p_revision_id and source.article_id = p_article_id and source.chapter_id = chapter;
  if article.id is null or revision.id is null then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if revision.import_candidate_key is not null
     and revision.status = 'retired'
     and not coalesce(p_confirm_verified, false) then
    delete from public.member_kb_article_revisions candidate
    where candidate.id = revision.id and candidate.import_candidate_key is not null;
    cached := pg_catalog.to_jsonb(article);
    insert into private.mi1_w2_operation_receipts (
      organization_id, operation, idempotency_key, request_payload, result
    ) values (org, 'restore_chapter_kb_revision', p_idempotency_key, request_payload, cached);
    perform private.mi1_w2_write_audit(org, 'knowledge_revision_restored', pg_catalog.jsonb_build_object(
      'organizationId', org, 'articleId', article.id,
      'restoredRevisionId', revision.id, 'restoredFromVersion', revision.version,
      'newVersion', article.version, 'status', article.status,
      'action', 'retirement_dismissed'
    ));
    return cached;
  end if;

  next_status := case
    when revision.import_candidate_key is not null
      and revision.status = 'retired'
      and coalesce(p_confirm_verified, false) then 'retired'
    when revision.status in ('draft', 'published')
      and coalesce(p_confirm_verified, false) then 'published'
    else 'draft'
  end;
  update public.member_kb_articles
  set kind = revision.kind,
      title = revision.title,
      article_ref = revision.article_ref,
      body = revision.body,
      keywords = revision.keywords,
      status = next_status,
      version = article.version + 1,
      knowledge_source_id = coalesce(revision.knowledge_source_id, article.knowledge_source_id),
      updated_by = actor,
      verified_by = case when next_status = 'published' then actor else null end,
      verified_at = case when next_status = 'published' then pg_catalog.now() else null end,
      updated_at = pg_catalog.now()
  where id = article.id returning * into restored;
  if revision.import_candidate_key is not null then
    delete from public.member_kb_article_revisions candidate where candidate.id = revision.id;
  end if;
  insert into public.member_kb_article_revisions (
    article_id, chapter_id, version, status, kind, title, article_ref, body,
    keywords, changed_by, verified_by, verified_at
  ) values (
    restored.id, restored.chapter_id, restored.version, restored.status,
    restored.kind, restored.title, restored.article_ref, restored.body,
    restored.keywords, actor, restored.verified_by, restored.verified_at
  );
  cached := pg_catalog.to_jsonb(restored);
  insert into private.mi1_w2_operation_receipts (
    organization_id, operation, idempotency_key, request_payload, result
  ) values (org, 'restore_chapter_kb_revision', p_idempotency_key, request_payload, cached);
  perform private.mi1_w2_write_audit(org, 'knowledge_revision_restored', pg_catalog.jsonb_build_object(
    'organizationId', org, 'articleId', restored.id,
    'restoredRevisionId', revision.id, 'restoredFromVersion', revision.version,
    'newVersion', restored.version, 'status', restored.status,
    'action', case when restored.status = 'retired' then 'retirement_confirmed' else 'revision_restored' end
  ));
  return cached;
end;
$function$;

revoke all on function public.restore_chapter_kb_revision(uuid, bigint, boolean, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.restore_chapter_kb_revision(uuid, bigint, boolean, uuid, text)
  to authenticated;

drop function if exists public.list_chapter_kb_revisions(uuid);

create function public.list_chapter_kb_revisions(
  p_article_id uuid,
  p_chapter_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  chapter text := coalesce(
    nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), ''),
    private.current_member_chapter()
  );
begin
  if not private.mfa_satisfied()
     or not private.mi1_knowledge_collection_staff(org)
     or chapter is null
     or not private.mi1_w2_same_org_chapter(org, chapter) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.member_kb_articles article
    where article.id = p_article_id and article.chapter_id = chapter and not article.is_sample
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', revision.id, 'version', revision.version, 'status', revision.status,
      'kind', revision.kind, 'title', revision.title, 'articleRef', revision.article_ref,
      'body', revision.body, 'keywords', revision.keywords,
      'changedBy', revision.changed_by, 'changedAt', revision.changed_at,
      'importCandidate', revision.import_candidate_key is not null
    ) order by revision.changed_at desc, revision.id desc)
    from (
      select source.* from public.member_kb_article_revisions source
      where source.article_id = p_article_id and source.chapter_id = chapter
      order by source.changed_at desc, source.id desc limit 50
    ) revision
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_chapter_kb_revisions(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_chapter_kb_revisions(uuid, text)
  to authenticated;
