begin;

-- SEC-UG-CLEANROOM-UPLOAD-SECURITY-20260904 — slice 4, third repair.
--
-- THE KNOWLEDGE LIFECYCLE ESCAPED THE QUARANTINE LEDGER AFTER INGESTION.
--
-- 20260906020000 gated the file-shaped surfaces — confirm, submit, approve,
-- filing, complete/review/publish/download/catalog — and explicitly exempted
-- `public.search_member_kb` and the review snapshot as "not Storage-backed".
-- That exemption was wrong. 20260903030000 gave `public.member_kb_articles`
-- and `public.member_kb_article_revisions` a `knowledge_source_id` column, so
-- an imported CBA clause is Storage-derived text carrying provenance straight
-- back to an `organization-knowledge` object. Once the extractor had run,
-- nothing consulted the ledger again:
--
--   * `public.authorize_knowledge_ingest` checked `private_upload_is_current`
--     ONCE and then handed a bucket/objectName to a service-role worker that
--     downloads bytes and returns later. Between the check and the completion
--     the object can be quarantined, superseded, expired or deleted — a plain
--     TOCTOU window, with the two service-role completion RPCs
--     (`replace_knowledge_source_chunks`, `replace_cba_knowledge_drafts`)
--     writing chunks and drafts on the strength of a verdict nobody re-read.
--   * the review snapshot, the review page, the revision list, the restore /
--     publication RPC and Compass retrieval all read that derived text with no
--     reference to the originating file at all. A source that went stale,
--     failed, blocked or deleted stayed indexed, reviewable, publishable and
--     retrievable.
--
-- This migration closes both halves.
--
-- 1. THE TWO COMPLETION RPCs RE-ESTABLISH THE VERDICT UNDER THE STORAGE LOCK.
--    Each derives the owning file from `p_source_id` server-side — no caller
--    supplies a path, a bucket or a digest, invariant 1 unchanged — takes
--    `select ... for update` on the owning `storage.objects` row, and only
--    then reads `private.private_upload_is_current`. Locking first is what
--    turns the race into a serialization: a concurrent verdict change either
--    commits before the lock is granted (and the completion refuses) or waits
--    behind it (and cannot land mid-write). Fail closed: an unresolvable
--    source, a missing file row and a missing object are all refusals.
--
-- 2. EVERY STORAGE-DERIVED READ AND PUBLICATION CONSULTS THE ORIGINATING FILE.
--    `private.knowledge_source_verdict_current(source_id)` is the one predicate
--    those surfaces use, and it is a thin, honest wrapper over the single
--    ledger predicate. It answers TRUE for `knowledge_source_id is null`
--    (authored articles, rights lessons, chapter documents — never Storage
--    derived) and for `storage_kind <> 'organization_storage'` (external_url,
--    inline `source_kind = 'text'`, Google Drive), so invariant 6 holds
--    exactly: non-Storage knowledge semantics survive untouched. It answers
--    FALSE — fail closed — whenever the provenance cannot be resolved.
--
--    Gated: `list_knowledge_review_articles_snapshot` (20260903040000 dropped
--    the paginated reader it replaced, and this migration does not resurrect
--    it), `list_chapter_kb_revisions`, `restore_chapter_kb_revision` and
--    `public.search_member_kb`.
--    `search_member_kb` stays `security invoker` and keeps every one of its
--    existing scopes; the conjunct is added to the `member_kb_articles` branch
--    only, so the rights-lesson and chapter-document branches are untouched.
--
-- Invariant 7 is unchanged: `private.private_upload_is_current` remains the
-- only expression consulted, and `organization_knowledge_files.scan_status` is
-- still not read anywhere here.

-- The read-side predicate. `stable`, and deliberately NOT locking: it is
-- evaluated per candidate row inside listing and retrieval queries, where a
-- row lock would be both wrong and expensive. The write side below is the one
-- that must serialize.
create or replace function private.knowledge_source_verdict_current(p_source_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  file public.organization_knowledge_files%rowtype;
begin
  -- Authored content has no Storage provenance to check.
  if p_source_id is null then return true; end if;
  select f.* into file
  from public.organization_knowledge_sources s
  join public.organization_knowledge_files f on f.id = s.file_id
  where s.id = p_source_id;
  -- A provenance that cannot be resolved is not a pass.
  if not found then return false; end if;
  -- external_url rows, inline text sources and Drive bytes are not in this
  -- ledger's scope and keep the semantics they had before this record.
  if file.storage_kind is distinct from 'organization_storage' then return true; end if;
  if file.storage_path is null then return false; end if;
  return private.private_upload_is_current('organization-knowledge', file.storage_path);
end;
$function$;

revoke all on function private.knowledge_source_verdict_current(uuid)
  from public, anon, authenticated, service_role;
-- `search_member_kb` is security INVOKER by design (UB-RGT-01/02), so the
-- member's own session evaluates this predicate; the definer body is what lets
-- it resolve provenance the member cannot select for itself.
grant execute on function private.knowledge_source_verdict_current(uuid)
  to authenticated, service_role;

comment on function private.knowledge_source_verdict_current(uuid) is
  'True when a knowledge source has no Storage provenance, is not organization_storage, or its owning object holds a current ledger verdict; false whenever the provenance cannot be resolved.';

-- The write-side twin. Volatile, service-role only, and it takes the owning
-- Storage row lock BEFORE reading the predicate, so a completion cannot be
-- decided against a verdict another session is in the middle of changing.
create or replace function private.knowledge_source_object_verdict_locked(
  p_organization_id uuid, p_source_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  file public.organization_knowledge_files%rowtype;
  locked_object_id uuid;
begin
  if p_organization_id is null or p_source_id is null then return false; end if;
  select f.* into file
  from public.organization_knowledge_sources s
  join public.organization_knowledge_files f
    on f.id = s.file_id and f.organization_id = p_organization_id
  where s.id = p_source_id and s.organization_id = p_organization_id;
  if not found then return false; end if;
  if file.storage_kind is distinct from 'organization_storage' then return true; end if;
  if file.storage_path is null then return false; end if;
  -- The lock is the point. `private_upload_is_current` joins storage.objects on
  -- id and version, so holding this row makes the predicate's answer stable for
  -- the rest of the transaction that is about to write derived rows.
  select o.id into locked_object_id
  from storage.objects o
  where o.bucket_id = 'organization-knowledge' and o.name = file.storage_path
  for update;
  if locked_object_id is null then return false; end if;
  return private.private_upload_is_current('organization-knowledge', file.storage_path);
end;
$function$;

revoke all on function private.knowledge_source_object_verdict_locked(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.knowledge_source_object_verdict_locked(uuid, uuid)
  to service_role;

comment on function private.knowledge_source_object_verdict_locked(uuid, uuid) is
  'Service-only write-side verdict recheck: derives the owning organization-knowledge object from a source id, locks its storage.objects row, then evaluates private.private_upload_is_current.';

-- --------------------------------------------------------------------------
-- 1. The two service-role completion RPCs.
-- --------------------------------------------------------------------------
create or replace function public.replace_knowledge_source_chunks(
  p_organization_id uuid, p_source_id uuid, p_actor_user_id uuid, p_chunks jsonb, p_error_code text
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  source public.organization_knowledge_sources%rowtype;
  item record;
  item_count integer;
  error_code text := nullif(pg_catalog.btrim(coalesce(p_error_code, '')), '');
begin
  if (select auth.role()) <> 'service_role'
     or p_organization_id is null or p_source_id is null or p_actor_user_id is null
     or pg_catalog.jsonb_typeof(coalesce(p_chunks, '[]'::jsonb)) <> 'array'
     or pg_catalog.jsonb_array_length(coalesce(p_chunks, '[]'::jsonb)) > 500
     or (error_code is not null and error_code !~ '^knowledge-[a-z0-9-]{1,110}$') then
    raise exception 'invalid ingest completion' using errcode = '22023';
  end if;
  select * into source from public.organization_knowledge_sources row
  where row.id = p_source_id and row.organization_id = p_organization_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from public.organization_memberships membership
    join public.organization_role_grants role
      on role.organization_id = membership.organization_id and role.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id = p_actor_user_id and membership.status = 'active'
      and role.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  ) then raise exception 'not authorized' using errcode = '42501'; end if;
  -- The verdict is re-established HERE, under the owning Storage row's lock,
  -- rather than trusted from the authorization that started the extraction.
  -- authorize_knowledge_ingest checked the ledger once and then handed a path
  -- to a worker that reads bytes and comes back later; between those two
  -- moments the object can be quarantined, superseded, expired or deleted.
  -- Deriving the file server-side from p_source_id and taking `for update` on
  -- the Storage row makes a concurrent verdict change serialize against this
  -- write instead of racing it. Fail closed: a source whose file cannot be
  -- resolved is refused exactly like one whose verdict has lapsed.
  if not private.knowledge_source_object_verdict_locked(p_organization_id, source.id) then
    raise exception 'file inspection required' using errcode = '42501';
  end if;
  delete from public.organization_knowledge_chunks chunk
  where chunk.source_id = source.id and chunk.organization_id = p_organization_id;
  if error_code is not null then
    update public.organization_knowledge_sources
    set chunk_count = 0, embedded_count = 0, health = 'failed',
        last_error = error_code, last_ingest_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where id = source.id and organization_id = p_organization_id;
    update public.organization_knowledge_files
    set index_status = 'failed', updated_at = pg_catalog.now()
    where id = source.file_id and organization_id = p_organization_id;
  else
    item_count := pg_catalog.jsonb_array_length(p_chunks);
    if item_count = 0 then raise exception 'ingest produced no chunks' using errcode = '22023'; end if;
    for item in select value, ordinality from pg_catalog.jsonb_array_elements_text(p_chunks) with ordinality loop
      if pg_catalog.char_length(item.value) not between 1 and 8000 then
        raise exception 'invalid knowledge chunk' using errcode = '22023';
      end if;
      insert into public.organization_knowledge_chunks (
        organization_id, source_id, chunk_index, content
      ) values (p_organization_id, source.id, item.ordinality - 1, item.value);
    end loop;
    update public.organization_knowledge_sources
    set chunk_count = item_count, embedded_count = 0, health = 'unset_embedding',
        last_error = null, last_ingest_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where id = source.id and organization_id = p_organization_id;
    update public.organization_knowledge_files
    set index_status = 'chunked', updated_at = pg_catalog.now()
    where id = source.file_id and organization_id = p_organization_id;
  end if;
  insert into public.organization_audit_events (
    organization_id, event_type, actor_user_id, idempotency_key, metadata
  ) values (
    p_organization_id, 'knowledge_source_retried', p_actor_user_id,
    extensions.gen_random_uuid(), pg_catalog.jsonb_build_object(
      'organizationId', p_organization_id, 'fileId', source.file_id, 'sourceId', source.id,
      'indexStatus', case when error_code is null then 'chunked' else 'failed' end,
      'action', case when error_code is null then 'ingested' else 'failed' end
    )
  );
  return pg_catalog.jsonb_build_object(
    'id', source.id, 'fileId', source.file_id,
    'chunkCount', case when error_code is null then item_count else 0 end,
    'embeddedCount', 0,
    'health', case when error_code is null then 'unset_embedding' else 'failed' end,
    'lastError', error_code
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

  -- Same recheck as replace_knowledge_source_chunks, for the same reason: the
  -- normalized clauses about to become reviewable drafts are DERIVED FROM the
  -- bytes of source_file, and the ledger may have moved since
  -- authorize_knowledge_ingest emitted that path. The file is derived here
  -- from p_source_id, never supplied, and the Storage row is locked before the
  -- predicate is read so a concurrent quarantine cannot land between them.
  if not private.knowledge_source_object_verdict_locked(p_organization_id, source.id) then
    raise exception 'file inspection required' using errcode = '42501';
  end if;

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

revoke all on function public.replace_knowledge_source_chunks(uuid, uuid, uuid, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.replace_knowledge_source_chunks(uuid, uuid, uuid, jsonb, text)
  to service_role;
revoke all on function public.replace_cba_knowledge_drafts(uuid, uuid, uuid, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.replace_cba_knowledge_drafts(uuid, uuid, uuid, text, jsonb)
  to service_role;

comment on function public.replace_knowledge_source_chunks(uuid, uuid, uuid, jsonb, text) is
  'Service-only bounded chunk replacement re-establishes the originating object''s ledger verdict under its Storage row lock before writing, validates the initiating staff actor, updates INDEX health only, and records an attributed audit event. It must never write organization_knowledge_files.scan_status again.';
comment on function public.replace_cba_knowledge_drafts(uuid, uuid, uuid, text, jsonb) is
  'Service-only, chapter-serialized CBA reconciliation re-establishes the originating object''s ledger verdict under its Storage row lock, then derives stable clause keys, preserves a collision-free contiguous agreement order range without versioning identical draft retries, keeps published and independently authored articles, clears stale candidates, and stages changed or missing verified clauses for explicit review.';

-- --------------------------------------------------------------------------
-- 2. Storage-derived snapshot, review, publication and retrieval surfaces.
-- --------------------------------------------------------------------------
create or replace function public.list_knowledge_review_articles_snapshot(
  p_chapter_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  target_chapter text := nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), '');
  org uuid := private.mi1_knowledge_context_organization(target_chapter);
begin
  if not private.mfa_satisfied()
     or not private.mi1_knowledge_collection_staff(org)
     or target_chapter is null
     or not private.mi1_w2_same_org_chapter(org, target_chapter) then
    raise exception 'not authorized' using errcode = '42501';
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
    from public.member_kb_articles article
    where article.chapter_id = target_chapter
      and not article.is_sample
      and private.knowledge_source_verdict_current(article.knowledge_source_id)
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.list_chapter_kb_revisions(
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
      and private.knowledge_source_verdict_current(article.knowledge_source_id)
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
        and private.knowledge_source_verdict_current(source.knowledge_source_id)
      order by source.changed_at desc, source.id desc limit 50
    ) revision
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.restore_chapter_kb_revision(
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
  -- Publication of storage-derived language needs a live verdict for the file
  -- the language came from. Both provenances are checked: the article's own
  -- source and the candidate revision's, because a restore can carry a
  -- revision's knowledge_source_id onto the article. Authored articles and
  -- non-Storage sources (external_url, inline text, Drive) answer true and
  -- keep their semantics unchanged.
  if not private.knowledge_source_verdict_current(article.knowledge_source_id)
     or not private.knowledge_source_verdict_current(revision.knowledge_source_id) then
    raise exception 'file inspection required' using errcode = '42501';
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

create or replace function public.search_member_kb(p_query text, p_limit integer default 4)
returns table (source_id text, kind text, title text, ref text, snippet text)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select
      case
        when pg_catalog.length(pg_catalog.btrim(coalesce(p_query, ''))) = 0 then null
        else nullif(
          pg_catalog.array_to_string(
            pg_catalog.tsvector_to_array(pg_catalog.to_tsvector('english', p_query)),
            ' | '
          ), ''
        )::tsquery
      end as ts,
      least(greatest(coalesce(p_limit, 4), 1), 6) as lim
  ),
  scored as (
    select
      'kb:' || a.slug as source_id,
      a.kind,
      a.title,
      a.article_ref as ref,
      pg_catalog.left(a.body, 320) as snippet,
      case
        when (select ts from q) is null
          then 0.001 * (100 - least(a.order_index, 99))::double precision
        else pg_catalog.ts_rank(
          pg_catalog.to_tsvector(
            'english',
            coalesce(a.title, '') || ' ' || coalesce(a.article_ref, '') || ' ' ||
            coalesce(a.body, '') || ' ' || pg_catalog.array_to_string(a.keywords, ' ')
          ),
          (select ts from q)
        )
      end as score,
      a.order_index as ord
    from public.member_kb_articles a
    where a.chapter_id = private.current_member_chapter()
      and not a.is_sample
      and a.status = 'published'
      and a.verified_by is not null
      and a.verified_at is not null
      and private.knowledge_source_verdict_current(a.knowledge_source_id)
      and (
        (select ts from q) is null
        or pg_catalog.to_tsvector(
             'english',
             coalesce(a.title, '') || ' ' || coalesce(a.article_ref, '') || ' ' ||
             coalesce(a.body, '') || ' ' || pg_catalog.array_to_string(a.keywords, ' ')
           ) @@ (select ts from q)
      )

    union all

    select
      'rights:' || l.id::text,
      'rights',
      l.title,
      'Know your rights · ' || l.label,
      pg_catalog.left(l.description, 320),
      pg_catalog.ts_rank(
        pg_catalog.to_tsvector(
          'english',
          coalesce(l.label, '') || ' ' || coalesce(l.title, '') || ' ' ||
          coalesce(l.description, '') || ' ' || coalesce(l.script, '')
        ),
        (select ts from q)
      ),
      1000 + l.order_index
    from public.member_rights_lessons l
    where (select ts from q) is not null
      and pg_catalog.to_tsvector(
            'english',
            coalesce(l.label, '') || ' ' || coalesce(l.title, '') || ' ' ||
            coalesce(l.description, '') || ' ' || coalesce(l.script, '')
          ) @@ (select ts from q)

    union all

    select
      'doc:' || d.id::text,
      'document',
      d.title,
      'Chapter library · ' || d.document_type,
      pg_catalog.left(coalesce(nullif(pg_catalog.btrim(d.summary), ''), d.body), 320),
      pg_catalog.ts_rank(
        pg_catalog.to_tsvector(
          'english',
          coalesce(d.title, '') || ' ' || coalesce(d.document_type, '') || ' ' ||
          coalesce(d.summary, '') || ' ' || coalesce(d.body, '')
        ),
        (select ts from q)
      ),
      1500
    from public.chapter_documents d
    where (select ts from q) is not null
      and d.chapter_id = private.current_member_chapter()
      and d.status = 'published'
      and pg_catalog.to_tsvector(
            'english',
            coalesce(d.title, '') || ' ' || coalesce(d.document_type, '') || ' ' ||
            coalesce(d.summary, '') || ' ' || coalesce(d.body, '')
          ) @@ (select ts from q)

  )
  select source_id, kind, title, ref, snippet
  from scored
  order by score desc, ord asc
  limit (select lim from q);
$$;

revoke all on function public.list_knowledge_review_articles_snapshot(text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_knowledge_review_articles_snapshot(text)
  to authenticated;
revoke all on function public.list_chapter_kb_revisions(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_chapter_kb_revisions(uuid, text)
  to authenticated;
revoke all on function public.restore_chapter_kb_revision(uuid, bigint, boolean, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.restore_chapter_kb_revision(uuid, bigint, boolean, uuid, text)
  to authenticated;
revoke all on function public.search_member_kb(text, integer) from public, anon;
grant execute on function public.search_member_kb(text, integer) to authenticated;

comment on function public.list_knowledge_review_articles_snapshot(text) is
  'Returns every reviewable article for one explicitly selected same-organization chapter from one statement snapshot, excluding articles whose originating Storage source no longer holds a current ledger verdict, so CBA reconciliation cannot move a cursor between pages.';
comment on function public.restore_chapter_kb_revision(uuid, bigint, boolean, uuid, text) is
  'Idempotent explicit-chapter staff review can draft or verify imported changes, confirm retirement, or dismiss a proposed removal without changing canonical content; it refuses whenever the article''s or the revision''s originating Storage source has lost its current ledger verdict.';

-- --------------------------------------------------------------------------
-- 3. The inspection endpoint can finally tell a stale session from a row it
--    is not allowed to see.
--
-- Every refusal in authorize_private_upload_inspection raised one 42501, which
-- api/private-files.js turns into one 403. That is correct for the row-shaped
-- refusals — unknown, foreign, removed and unauthorized MUST stay
-- indistinguishable, or the endpoint becomes a file-existence oracle — but it
-- also swallowed the one refusal that is not about a row at all: the caller's
-- own MFA session being stale. Native durable recovery paid for that
-- conflation. After the service reconciler deleted a rejected upload's row,
-- the client saw the same 403 it uses for stale MFA, reported
-- 'reauth-required', and deliberately kept its recovery marker — so the member
-- could reauthenticate forever while share intake stayed blocked.
--
-- The session refusal is now returned as a structured `{reauthRequired: true}`
-- answer, in the same shape as `busy` and `rateLimited`, evaluated before
-- p_file_id is looked at, before any lock and before the quota is charged. The
-- enumeration surface is unchanged: an unauthorized caller still gets the same
-- 403 an absent row gets. What changed is that an AUTHORIZED caller whose row
-- is gone no longer receives the reauthentication answer, so the client can act
-- on it — which it does, by attempting the idempotent abort/status transition
-- and clearing its marker only on an exact absent/deleted receipt.
-- --------------------------------------------------------------------------
create or replace function public.authorize_private_upload_inspection(p_kind text, p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  actor uuid := (select auth.uid());
  target jsonb;
  allowed boolean := false;
  object storage.objects%rowtype;
  quota private.private_upload_inspection_limits%rowtype;
  attempt private.private_upload_inspection_attempts%rowtype;
  attempt_id uuid := extensions.gen_random_uuid();
  checked_at timestamptz := pg_catalog.now();
begin
  -- A caller that is not an authenticated end user has no business here at
  -- all, and says nothing about any file by being refused.
  if (select auth.role()) is distinct from 'authenticated' or actor is null then
    raise exception 'file unavailable' using errcode = '42501';
  end if;
  -- A STALE MFA SESSION IS A FACT ABOUT THE CALLER, NOT ABOUT ANY ROW.
  -- It is evaluated before p_file_id is looked at, so answering it distinctly
  -- reveals nothing about whether that file exists, belongs to this actor, or
  -- was removed — the enumeration surface is unchanged. Every row-shaped
  -- refusal below stays merged into one indistinguishable 42501: unknown,
  -- foreign, removed and unauthorized all answer identically.
  --
  -- Making this one distinguishable is what lets a client tell "verify it is
  -- you" from "this file is not available to you". Native durable recovery
  -- needed exactly that: after the service reconciler deletes a rejected
  -- upload's row, the missing row produced the same refusal as a stale MFA
  -- session, so the client kept a recovery marker no amount of
  -- reauthentication could ever clear (see apps/mobile/src/services/
  -- attachments.ts). It is returned rather than raised so it travels as a
  -- structured answer alongside 'busy' and 'rateLimited', and it is returned
  -- BEFORE any lookup, lock or quota charge.
  if not private.mfa_satisfied() then
    return pg_catalog.jsonb_build_object('reauthRequired', true);
  end if;
  if p_kind = 'case' then
    select pg_catalog.jsonb_build_object('bucketId', f.bucket_id, 'objectName', f.object_name,
      'filename', f.filename, 'mimeType', f.mime_type, 'sizeBytes', f.size_bytes),
      private.can_read_member_case_object(f.bucket_id, f.object_name)
        or private.can_write_member_case_object(f.bucket_id, f.object_name)
    into target, allowed from public.member_case_files f
    where f.id = p_file_id and f.removal_requested_at is null and f.cleanup_requested_at is null;
  elsif p_kind = 'task' then
    select pg_catalog.jsonb_build_object('bucketId', f.bucket_id, 'objectName', f.object_name,
      'filename', f.filename, 'mimeType', f.mime_type, 'sizeBytes', f.size_bytes),
      private.can_read_chapter_task_object(f.bucket_id, f.object_name)
        or private.can_write_chapter_task_object(f.bucket_id, f.object_name)
    into target, allowed from public.chapter_task_files f
    where f.id = p_file_id and f.removal_requested_at is null and f.cleanup_requested_at is null;
  elsif p_kind = 'form' then
    select pg_catalog.jsonb_build_object('bucketId', f.bucket_id, 'objectName', f.object_name,
      'filename', f.filename, 'mimeType', f.mime_type, 'sizeBytes', f.size_bytes),
      private.can_read_member_form_object(f.bucket_id, f.object_name)
        or private.can_write_member_form_object(f.bucket_id, f.object_name)
    into target, allowed from public.member_form_files f
    where f.id = p_file_id and f.deletion_requested_at is null;
  elsif p_kind = 'knowledge' then
    select pg_catalog.jsonb_build_object('bucketId', 'organization-knowledge', 'objectName', f.storage_path,
      'filename', f.file_name, 'mimeType', f.mime_type, 'sizeBytes', f.byte_size, 'sha256', f.content_sha256),
      private.can_insert_organization_knowledge_object('organization-knowledge', f.storage_path)
        or private.can_read_organization_knowledge_object('organization-knowledge', f.storage_path)
    into target, allowed from public.organization_knowledge_files f
    where f.id = p_file_id and f.storage_kind = 'organization_storage';
  end if;
  -- Unknown, foreign, removed and unauthorized identities have one response.
  if target is null or allowed is distinct from true then
    raise exception 'file unavailable' using errcode = '42501';
  end if;
  -- Serialize an actor's quota before taking any Storage lock. All functions
  -- that touch both object and attempt rows lock Storage first, then attempt.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('private-upload:' || actor::text, 509));
  select * into object from storage.objects
  where bucket_id = target->>'bucketId' and name = target->>'objectName' for update;
  if object.id is null then raise exception 'file unavailable' using errcode = '42501'; end if;
  -- Knowledge preparation reserves name/size/digest before MIME is recorded.
  -- The immutable Storage declaration is still only a claim: the inspector
  -- validates it against the filename and the actual downloaded bytes.
  if target->>'mimeType' is null then
    target := target || pg_catalog.jsonb_build_object('mimeType', object.metadata->>'mimetype');
  end if;
  if private.private_upload_is_current(object.bucket_id, object.name) then
    return pg_catalog.jsonb_build_object('fileId', p_file_id, 'current', true);
  end if;
  select * into attempt from private.private_upload_inspection_attempts a where a.object_id = object.id for update;
  if attempt.completed_at is null and attempt.expires_at > checked_at then
    return pg_catalog.jsonb_build_object('busy', true);
  end if;
  insert into private.private_upload_inspection_limits(user_id, hour_started, hour_count, day_started, day_count)
  values(actor, checked_at, 0, checked_at, 0) on conflict (user_id) do nothing;
  select * into quota from private.private_upload_inspection_limits where user_id = actor for update;
  if quota.hour_started <= checked_at - interval '1 hour' then quota.hour_started := checked_at; quota.hour_count := 0; end if;
  if quota.day_started <= checked_at - interval '24 hours' then quota.day_started := checked_at; quota.day_count := 0; end if;
  if quota.hour_count >= 20 or quota.day_count >= 100 then
    return pg_catalog.jsonb_build_object('rateLimited', true);
  end if;
  update private.private_upload_inspection_limits set hour_started = quota.hour_started, hour_count = quota.hour_count + 1,
    day_started = quota.day_started, day_count = quota.day_count + 1 where user_id = actor;
  insert into private.private_upload_inspection_attempts(object_id, id, object_version, bucket_id, object_name, actor_user_id, expires_at)
  values(object.id, attempt_id, object.version, object.bucket_id, object.name, actor, checked_at + interval '60 seconds')
  on conflict (object_id) do update set id = excluded.id, object_version = excluded.object_version,
    actor_user_id = excluded.actor_user_id, expires_at = excluded.expires_at, completed_at = null;
  return target || pg_catalog.jsonb_build_object('fileId', p_file_id, 'attemptId', attempt_id,
    'objectId', object.id, 'objectVersion', object.version, 'current', false);
end
$function$;

revoke all on function public.authorize_private_upload_inspection(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_private_upload_inspection(text, uuid)
  to authenticated;

comment on function public.authorize_private_upload_inspection(text, uuid) is
  'Caller-JWT, MFA, feature-ACL, quota and 60 s lease authorization for one private-upload inspection; a stale MFA session answers {reauthRequired:true} before any lookup, while unknown, foreign, removed and unauthorized rows stay one indistinguishable refusal.';

notify pgrst, 'reload schema';
commit;
