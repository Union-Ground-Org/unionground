begin;

-- SEC-UG-CLEANROOM-UPLOAD-SECURITY-20260904 — slice 4, sixth repair.
--
-- Round-2 security review of d530dada found the quarantine-lifecycle escape
-- still open through two independent revision-history paths. This migration
-- closes both, forward-only.
--
-- ==========================================================================
-- P1-a. CANONICAL REVISIONS LOSE THEIR STORAGE PROVENANCE
-- ==========================================================================
--
-- 20260903030000 gave public.member_kb_article_revisions a knowledge_source_id
-- and then bound it to import_candidate_key with an EQUALITY constraint:
--
--     member_kb_article_revisions_import_candidate_complete
--       check ((import_candidate_key is null) = (knowledge_source_id is null))
--
-- Combined with member_kb_article_revisions_version_shape (a positive version
-- requires a null import_candidate_key) that FORCED every canonical revision to
-- knowledge_source_id = NULL. Every canonical writer complied by omitting the
-- column. And a null knowledge_source_id is read as "authored, no Storage
-- provenance to check" by private.knowledge_source_verdict_current, which
-- answers true for it by design (invariant 6).
--
-- So Storage-derived canonical history was indistinguishable from authored
-- history, and this sequence laundered a lapsed source's text onto a clean one:
--
--   1. Source A imports and publishes clauses. Every canonical revision holds
--      A's text with null provenance.
--   2. A replacement source B stages a candidate for the same clause key; a
--      reviewer restores it, and the ARTICLE moves to B.
--   3. A goes stale, blocked, failed or deleted. B stays current.
--   4. list_chapter_kb_revisions passes: the article-level check reads B (fine)
--      and the per-revision check reads NULL (fine, "authored"). A's text is
--      listed.
--   5. restore_chapter_kb_revision republishes A's text and, through
--      `knowledge_source_id = coalesce(revision.knowledge_source_id,
--      article.knowledge_source_id)`, keeps B's provenance on the article.
--
-- THE FIX IS AN EXPLICIT DISCRIMINATOR, NOT AN INFERENCE. A new column
-- public.member_kb_article_revisions.content_origin, `not null`, with NO
-- DEFAULT — a default is precisely how a future writer would silently classify
-- derived text as authored — taking one of three values:
--
--   'authored'   — the text was typed by staff into an article that has never
--                  had Storage provenance. Requires a null knowledge_source_id.
--   'derived'    — the text came out of an inspected Storage object. Requires a
--                  NON-NULL knowledge_source_id naming the exact source, so
--                  every derived row is gated on its OWN provenance rather than
--                  on whatever source the article happens to carry today.
--   'unresolved' — a historical row whose true origin this migration cannot
--                  prove. It is NOT authored. It is never listed, never
--                  returned and never republished; it is retained because the
--                  revision table is the immutable record of what was
--                  published, and deleting evidence is not a security fix.
--
-- THE EXACT BACKFILL PREDICATE.
--
--   version = 0  ->  'derived'.
--       A version-zero row is an import candidate. The old equality constraint
--       already required knowledge_source_id to be non-null on exactly these
--       rows, so the exact source is recorded ON THE ROW ITSELF. Provable.
--
--   version > 0 AND the owning article has no Storage provenance and has never
--   had any  ->  'authored'.
--       Stated exactly: article.knowledge_source_id is null AND
--       article.import_key is null (the two are tied by
--       member_kb_articles_import_provenance_complete) AND no revision of that
--       article carries a non-null knowledge_source_id (no import candidate is
--       or ever was staged on it — a candidate row is the only place this table
--       has ever recorded a source).
--
--       "has never had any" is provable because knowledge_source_id on
--       public.member_kb_articles is MONOTONE at this head. Every writer that
--       touches it either leaves it alone or sets it to a non-null source:
--       replace_cba_knowledge_drafts sets `knowledge_source_id = p_source_id`
--       on the update branch and inserts p_source_id on the create branch;
--       restore_chapter_kb_revision wrote
--       `coalesce(revision.knowledge_source_id, article.knowledge_source_id)`,
--       which cannot produce null from a non-null article value;
--       save_chapter_kb_article and retire_chapter_kb_article never mention the
--       column. No shipped migration sets it back to null. Therefore a null
--       today proves it was null for the whole life of the row, which proves no
--       writer ever copied Storage-derived text into any of its revisions — all
--       five writers copy the ARTICLE's own current text.
--
--       This is also why SAMPLE/seeded repository content classifies as
--       authored rather than by a special case: private.demo_seed_apply_
--       knowledge_library writes literal strings that live in a shipped
--       migration file, and it never sets knowledge_source_id, so its articles
--       satisfy the predicate above on their own. Nothing about them came out
--       of Storage bytes, and nothing about them can be re-inspected.
--
--   everything else  ->  'unresolved'.
--       A positive-version row on an article that carries a Storage source
--       today. Its text came from SOME source in that article's lineage, and
--       nothing in this schema records WHICH: the source is not on the row, the
--       audit envelope's knowledge_source_retried event carries sourceId but no
--       articleId, and knowledge_revision_restored carries articleId but no
--       sourceId. Guessing "the article's current source" is exactly the
--       coalesce defect this migration exists to remove, and guessing
--       "authored" is the escape itself. So it stays unavailable.
--
-- The hosted databases have applied no 202609060xxxxx migration, so this
-- backfill runs once against real historical rows.
--
-- FROM HERE ON, ORIGIN IS AN ARTICLE PROPERTY, WRITTEN EXPLICITLY. Every
-- canonical writer stamps the origin of the article it is snapshotting:
-- a derived article's new revision is 'derived' and carries the article's
-- current knowledge_source_id; an authored article's new revision is
-- 'authored' with a null source. A STAFF EDIT OF DERIVED TEXT DOES NOT LAUNDER
-- IT INTO AUTHORED TEXT — save_chapter_kb_article and retire_chapter_kb_article
-- rewrite or retire language that still came out of a file, so their revisions
-- stay bound to that file's verdict. The only way an article becomes authored
-- is to have been authored all along.
--
-- ==========================================================================
-- P1-b. CACHED RESTORE RECEIPTS RETURNED CONTENT BEFORE ANY CHECK
-- ==========================================================================
--
-- restore_chapter_kb_revision cached `to_jsonb(restored)` — title, article_ref,
-- body, keywords, the whole article — in private.mi1_w2_operation_receipts, and
-- returned it from the idempotency branch BEFORE the article lookup, the
-- chapter/sample check and both provenance checks. Replaying the key after the
-- source went stale, blocked, failed or deleted handed back the full derived
-- text with the ledger never consulted, and after the article was retired or
-- moved it handed back a row that no longer existed in that shape.
--
-- The receipt now stores ONLY non-content lifecycle metadata — articleId,
-- newVersion, status, restoredRevisionId, action — and the replay is
-- reconstructed through a gated read in
-- private.knowledge_revision_restore_receipt: the article must still exist in
-- this chapter, must not be sample, and its CURRENT knowledge_source_id must
-- hold a current ledger verdict, refusing with the same P0002 / 42501
-- 'file inspection required' the primary path uses. A receipt that carries any
-- content key at all is refused outright, so a pre-existing content-bearing
-- receipt written before this migration can never be replayed.
--
-- The receipt is also bound to the ACTOR: auth.uid() is now part of the compared
-- request payload. Two separate mechanisms sit behind that sentence and they
-- must not be conflated. private.mi1_w2_operation_receipts is itself an
-- ACTOR-KEYED VIEW (20260826156000) over private.mi1_w2_operation_receipt_rows,
-- whose primary key carries actor_user_id, so a second staff member in the same
-- organization replaying another actor's key never SEES that actor's receipt:
-- the lookup finds nothing, and the replay is an ordinary distinct operation
-- that runs the full gated path and writes its own receipt. It is not refused.
-- The payload binding is the defence for the case that namespace does not
-- cover — a receipt that IS visible under the caller's own actor id but was
-- stored for a different request — and THAT is what raises 22023. (It is also
-- why every receipt written before this migration refuses on a same-actor
-- replay: such a row carries no 'actorId' key, so the comparison fails. The web
-- client mints a fresh crypto.randomUUID() per call, so only an in-flight
-- network retry can observe it, and a refusal is the safe answer for one.)
--
-- AUDIT OF EVERY OTHER RECEIPT READER THAT COULD RETURN KNOWLEDGE CONTENT.
-- Enumerated from the live catalog — pg_proc bodies that read
-- private.mi1_w2_operation_receipts and hold EXECUTE for authenticated (none
-- holds it for anon or service_role) — not from a scan of migration files:
-- exactly seven functions read the receipt table in their own body.
--   public.prepare_steward_library_upload, public.complete_steward_library_upload
--   and public.publish_steward_file_to_catalog cache
--   private.mi1_w2_project_knowledge_file's projection of
--   organization_knowledge_files — the staff-typed title/summary/category and
--   lifecycle fields of the upload row, which 20260906022000 already stripped
--   of scan_status and which has never carried a bucket, an object name, a
--   storage path or any byte-derived text.
--   public.clear_knowledge_ingest_source_chunks and
--   public.retry_knowledge_ingest_source cache only
--   public.get_knowledge_ingest_source's projection
--   {id, fileId, kind, label, chunkCount, embeddedCount, health, lastIngestAt,
--   lastError} — source-lifecycle metadata: no article title, article_ref, body
--   or keywords, no bucket, object name or storage path, nothing byte-derived
--   (label is the staff-typed source label, lastError an ingest diagnostic).
--   public.set_case_restriction caches only {caseId, restricted}.
--   public.restore_chapter_kb_revision — this function — is the ONLY reader
--   that can return knowledge ARTICLE content, and its receipt is repaired
--   above.
-- Two private helpers also touch the table and are not public readers:
-- private.member_operations_replay and private.member_operations_store_receipt
-- are revoked from public, anon, authenticated and service_role
-- (20260830160000), and the twelve member-operations RPCs that replay through
-- the first reference no member_kb_article relation, no article_ref and no
-- organization_knowledge relation, so no knowledge content can reach a cached
-- replay through them. public.save_chapter_kb_article and
-- public.retire_chapter_kb_article take no idempotency key and read no receipt;
-- public.replace_cba_knowledge_drafts is service-role only and returns counts;
-- the collection RPCs delegate their response to the gated
-- public.list_knowledge_collections. So the rule is applied where content
-- exists, and the census is recorded here rather than left to be re-derived;
-- docs/security/private-upload-inspection.md carries the same census as a
-- table and tests/knowledge-receipt-reader-census-migration.test.js pins the
-- two against each other.
--
-- Invariants are unchanged. private.private_upload_is_current remains the one
-- expression consulted (invariant 7), reached through the same
-- private.knowledge_source_verdict_current wrapper; organization_knowledge_
-- files.scan_status is still not read; no caller supplies a path, bucket,
-- digest or verdict (invariant 1); non-Storage sources and authored content
-- keep their semantics exactly (invariant 6).

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- --------------------------------------------------------------------------
-- 1. The discriminator, its backfill and its shape constraints.
-- --------------------------------------------------------------------------
-- Added nullable and with no default so the backfill below is the only thing
-- that can decide an existing row's origin, and so no future insert can omit
-- the column and be silently classified.
alter table public.member_kb_article_revisions
  add column content_origin text;

-- Provable from the row itself: version zero is an import candidate and the old
-- equality constraint already required its exact source to be recorded.
update public.member_kb_article_revisions revision
set content_origin = 'derived'
where revision.content_origin is null
  and revision.import_candidate_key is not null;

-- Provable from article-level monotonicity: an article with no Storage
-- provenance today has never had any, so nothing derived was ever snapshotted
-- into its canonical history.
update public.member_kb_article_revisions revision
set content_origin = 'authored'
where revision.content_origin is null
  and revision.version > 0
  and exists (
    select 1
    from public.member_kb_articles article
    where article.id = revision.article_id
      and article.knowledge_source_id is null
      and article.import_key is null
  )
  and not exists (
    select 1
    from public.member_kb_article_revisions sibling
    where sibling.article_id = revision.article_id
      and sibling.knowledge_source_id is not null
  );

-- Everything left is a positive-version row on an article that carries a
-- Storage source. Which source produced this particular text is not recorded
-- anywhere, so it is neither authored nor attributable, and it is withheld.
update public.member_kb_article_revisions revision
set content_origin = 'unresolved'
where revision.content_origin is null;

alter table public.member_kb_article_revisions
  alter column content_origin set not null,
  drop constraint member_kb_article_revisions_import_candidate_complete,
  add constraint member_kb_article_revisions_content_origin_known
    check (content_origin in ('authored', 'derived', 'unresolved')),
  add constraint member_kb_article_revisions_candidate_is_derived
    check (
      import_candidate_key is null
      or (content_origin = 'derived' and knowledge_source_id is not null)
    ),
  add constraint member_kb_article_revisions_derived_names_its_source
    check (content_origin <> 'derived' or knowledge_source_id is not null),
  add constraint member_kb_article_revisions_authored_has_no_source
    check (content_origin <> 'authored' or knowledge_source_id is null);

comment on column public.member_kb_article_revisions.content_origin is
  'Explicit content-origin discriminator: authored (staff-typed, null knowledge_source_id), derived (lifted from an inspected Storage object, knowledge_source_id names the exact source and gates the row), or unresolved (historical row whose true origin cannot be proved; never listed, returned or republished, and never treated as authored).';

-- Derived history is read per source, so give the gate an index that answers on
-- the same key the reader filters by.
create index if not exists member_kb_article_revisions_origin_source_idx
  on public.member_kb_article_revisions (article_id, content_origin, knowledge_source_id);

-- --------------------------------------------------------------------------
-- 4. CBA reconciliation: every revision it writes states its origin.
-- --------------------------------------------------------------------------
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
            import_candidate_key, knowledge_source_id, content_origin
          ) values (
            current_article.id, current_article.chapter_id, 0,
            'draft', current_article.kind, clean_title, clean_ref, clean_body,
            clean_keywords, p_actor_user_id, null, null, candidate_key, p_source_id,
            'derived'
          ) on conflict (article_id, version) do update set
            status = excluded.status,
            content_origin = excluded.content_origin,
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
      body, keywords, changed_by, verified_by, verified_at,
      content_origin, knowledge_source_id
    ) select
      article.id, article.chapter_id, article.version, article.status,
      article.kind, article.title, article.article_ref, article.body,
      article.keywords, p_actor_user_id, article.verified_by, article.verified_at,
      case when article.knowledge_source_id is null then 'authored' else 'derived' end,
      article.knowledge_source_id
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
    body, keywords, changed_by, verified_by, verified_at,
    content_origin, knowledge_source_id
  ) select
    article.id, article.chapter_id, article.version, article.status,
    article.kind, article.title, article.article_ref, article.body,
    article.keywords, p_actor_user_id, article.verified_by, article.verified_at,
    case when article.knowledge_source_id is null then 'authored' else 'derived' end,
    article.knowledge_source_id
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
      import_candidate_key, knowledge_source_id, content_origin
    ) values (
      current_article.id, current_article.chapter_id, 0,
      'retired', current_article.kind, current_article.title,
      current_article.article_ref, current_article.body,
      current_article.keywords, p_actor_user_id, null, null,
      candidate_key, p_source_id, 'derived'
    ) on conflict (article_id, version) do update set
      status = excluded.status,
      content_origin = excluded.content_origin,
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

-- --------------------------------------------------------------------------
-- 5. Revision history: per-revision provenance and the unresolved exclusion.
-- --------------------------------------------------------------------------
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
      'contentOrigin', revision.content_origin,
      'importCandidate', revision.import_candidate_key is not null
    ) order by revision.changed_at desc, revision.id desc)
    from (
      select source.* from public.member_kb_article_revisions source
      where source.article_id = p_article_id and source.chapter_id = chapter
        and source.content_origin <> 'unresolved'
        and private.knowledge_source_verdict_current(source.knowledge_source_id)
      order by source.changed_at desc, source.id desc limit 50
    ) revision
  ), '[]'::jsonb);
end;
$function$;

-- --------------------------------------------------------------------------
-- 2. The gated replay reconstructor (P1-b).
--
-- A cached restore receipt is now lifecycle metadata only. This is the ONLY
-- way it becomes a response again, so "no cached replay bypasses a verdict
-- gate" is a property of one small function rather than of an ordering inside
-- a 130-line body. It refuses a receipt that carries any content key at all,
-- which retires every content-bearing receipt written before this migration.
-- --------------------------------------------------------------------------
create function private.knowledge_revision_restore_receipt(
  p_chapter_id text,
  p_receipt jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  article public.member_kb_articles%rowtype;
begin
  if p_receipt is null
     or pg_catalog.jsonb_typeof(p_receipt) is distinct from 'object'
     or p_receipt ? 'title'
     or p_receipt ? 'article_ref'
     or p_receipt ? 'body'
     or p_receipt ? 'keywords'
     or not (p_receipt ? 'articleId') then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  select * into article
  from public.member_kb_articles source
  where source.id = (p_receipt ->> 'articleId')::uuid
    and source.chapter_id = p_chapter_id
    and not source.is_sample;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if not private.knowledge_source_verdict_current(article.knowledge_source_id) then
    raise exception 'file inspection required' using errcode = '42501';
  end if;
  return pg_catalog.to_jsonb(article);
end;
$function$;

revoke all on function private.knowledge_revision_restore_receipt(text, jsonb)
  from public, anon, authenticated, service_role;

comment on function private.knowledge_revision_restore_receipt(text, jsonb) is
  'Rebuilds a restore response from a content-free lifecycle receipt through a current gated read: the article must still exist in the receipt chapter and not be sample, and its current knowledge_source_id must hold a current ledger verdict. A receipt carrying any article content key is refused outright.';

-- --------------------------------------------------------------------------
-- 3. Restore: per-revision provenance, no coalesce, no content-bearing cache.
-- --------------------------------------------------------------------------
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
  restored_source uuid;
  lifecycle jsonb;
  request_payload jsonb := pg_catalog.jsonb_build_object(
    'articleId', p_article_id, 'revisionId', p_revision_id,
    'confirmVerified', coalesce(p_confirm_verified, false),
    'actorId', actor
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
    return private.knowledge_revision_restore_receipt(chapter, cached);
  end if;
  select * into article from public.member_kb_articles source
  where source.id = p_article_id and source.chapter_id = chapter and not source.is_sample
  for update;
  select * into revision from public.member_kb_article_revisions source
  where source.id = p_revision_id and source.article_id = p_article_id and source.chapter_id = chapter;
  if article.id is null or revision.id is null then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  -- An unresolved row is not authored and is not attributable. It is hidden by
  -- list_chapter_kb_revisions, so it answers with the same refusal a revision
  -- that is not there answers with: distinguishing them would turn this RPC
  -- into an oracle for withheld history.
  if revision.content_origin = 'unresolved' then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  -- Publication of storage-derived language needs a live verdict for the file
  -- the language came from. Both provenances are checked: the article's own
  -- source and the candidate revision's OWN source, which since this migration
  -- is recorded on every derived row rather than inherited from the article.
  -- Authored revisions carry a null source, and authored articles and
  -- non-Storage sources (external_url, inline text, Drive) answer true and keep
  -- their semantics unchanged.
  if not private.knowledge_source_verdict_current(article.knowledge_source_id)
     or not private.knowledge_source_verdict_current(revision.knowledge_source_id) then
    raise exception 'file inspection required' using errcode = '42501';
  end if;
  -- The restored article takes the REVISION's own content source. The previous
  -- body wrote coalesce(revision.knowledge_source_id, article.knowledge_source_id),
  -- which stamped an unrelated current source onto republished text from a
  -- different file. An authored revision restores an authored article.
  restored_source := case
    when revision.content_origin = 'derived' then revision.knowledge_source_id
    else null
  end;
  -- Under the writer rules this migration establishes, a derived article only
  -- ever holds derived revisions and an authored article only ever holds
  -- authored ones, so this cannot fire. It is written as a refusal rather than
  -- a silent adjustment because the alternative is rewriting import_key to keep
  -- member_kb_articles_import_provenance_complete satisfied, which would detach
  -- a clause from the lineage a later reconciliation reconciles against.
  if (restored_source is null) is distinct from (article.knowledge_source_id is null) then
    raise exception 'revision provenance does not match this article' using errcode = '22023';
  end if;

  if revision.import_candidate_key is not null
     and revision.status = 'retired'
     and not coalesce(p_confirm_verified, false) then
    delete from public.member_kb_article_revisions candidate
    where candidate.id = revision.id and candidate.import_candidate_key is not null;
    lifecycle := pg_catalog.jsonb_build_object(
      'articleId', article.id, 'newVersion', article.version,
      'status', article.status, 'restoredRevisionId', revision.id,
      'action', 'retirement_dismissed'
    );
    insert into private.mi1_w2_operation_receipts (
      organization_id, operation, idempotency_key, request_payload, result
    ) values (org, 'restore_chapter_kb_revision', p_idempotency_key, request_payload, lifecycle);
    perform private.mi1_w2_write_audit(org, 'knowledge_revision_restored', pg_catalog.jsonb_build_object(
      'organizationId', org, 'articleId', article.id,
      'restoredRevisionId', revision.id, 'restoredFromVersion', revision.version,
      'newVersion', article.version, 'status', article.status,
      'action', 'retirement_dismissed'
    ));
    return pg_catalog.to_jsonb(article);
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
      knowledge_source_id = restored_source,
      updated_by = actor,
      verified_by = case when next_status = 'published' then actor else null end,
      verified_at = case when next_status = 'published' then pg_catalog.now() else null end,
      updated_at = pg_catalog.now()
  where id = article.id returning * into restored;
  if revision.import_candidate_key is not null then
    delete from public.member_kb_article_revisions candidate where candidate.id = revision.id;
  end if;
  -- The new canonical revision inherits the restored article's origin, so
  -- republishing derived text through review keeps it bound to its file.
  insert into public.member_kb_article_revisions (
    article_id, chapter_id, version, status, kind, title, article_ref, body,
    keywords, changed_by, verified_by, verified_at,
    content_origin, knowledge_source_id
  ) values (
    restored.id, restored.chapter_id, restored.version, restored.status,
    restored.kind, restored.title, restored.article_ref, restored.body,
    restored.keywords, actor, restored.verified_by, restored.verified_at,
    case when restored.knowledge_source_id is null then 'authored' else 'derived' end,
    restored.knowledge_source_id
  );
  lifecycle := pg_catalog.jsonb_build_object(
    'articleId', restored.id, 'newVersion', restored.version,
    'status', restored.status, 'restoredRevisionId', revision.id,
    'action', case when restored.status = 'retired' then 'retirement_confirmed' else 'revision_restored' end
  );
  insert into private.mi1_w2_operation_receipts (
    organization_id, operation, idempotency_key, request_payload, result
  ) values (org, 'restore_chapter_kb_revision', p_idempotency_key, request_payload, lifecycle);
  perform private.mi1_w2_write_audit(org, 'knowledge_revision_restored', pg_catalog.jsonb_build_object(
    'organizationId', org, 'articleId', restored.id,
    'restoredRevisionId', revision.id, 'restoredFromVersion', revision.version,
    'newVersion', restored.version, 'status', restored.status,
    'action', case when restored.status = 'retired' then 'retirement_confirmed' else 'revision_restored' end
  ));
  return pg_catalog.to_jsonb(restored);
end;
$function$;

-- --------------------------------------------------------------------------
-- 6. The remaining canonical writers.
--
-- save and retire snapshot the ARTICLE's own current text, so each revision
-- takes the article's origin. Editing or retiring Storage-derived language
-- does not turn it into authored language.
-- --------------------------------------------------------------------------
create or replace function public.save_chapter_kb_article(
  p_article_id uuid,
  p_kind text,
  p_title text,
  p_article_ref text,
  p_body text,
  p_keywords text[],
  p_status text,
  p_confirm_verified boolean,
  p_chapter_id text default null
)
returns public.member_kb_articles
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.mi1_w2_selected_organization();
  home_chapter text := private.current_member_chapter();
  requested_chapter text := nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), '');
  caller_chapter text := coalesce(requested_chapter, home_chapter);
  clean_kind text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_kind, '')));
  clean_title text := pg_catalog.btrim(coalesce(p_title, ''));
  clean_ref text := pg_catalog.btrim(coalesce(p_article_ref, ''));
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''));
  clean_status text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_status, '')));
  clean_keywords text[];
  saved public.member_kb_articles%rowtype;
  next_id uuid;
begin
  if caller is null
     or caller_chapter is null
     or not private.mi1_w2_same_org_chapter(org, caller_chapter)
     or not (
       private.mi1_knowledge_collection_staff(org)
       or (
         caller_chapter is not distinct from home_chapter
         and public.member_has_role(array['steward','coordinator','advisor','admin','vp'])
       )
     ) then
    raise exception 'staff role and authorized chapter required' using errcode = '42501';
  end if;

  if clean_kind not in ('contract', 'rights', 'faq') then
    raise exception 'invalid knowledge kind' using errcode = '22023';
  end if;
  if clean_status not in ('draft', 'published') then
    raise exception 'invalid knowledge status' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_title) not between 1 and 200 then
    raise exception 'title must be between 1 and 200 characters' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_ref) not between 1 and 120 then
    raise exception 'reference must be between 1 and 120 characters' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_body) not between 1 and 100000 then
    raise exception 'content must be between 1 and 100000 characters' using errcode = '22023';
  end if;
  if pg_catalog.cardinality(coalesce(p_keywords, '{}'::text[])) > 30
     or exists (
       select 1
       from pg_catalog.unnest(coalesce(p_keywords, '{}'::text[])) as keyword(value)
       where pg_catalog.char_length(pg_catalog.btrim(keyword.value)) > 80
     ) then
    raise exception 'keywords must contain at most 30 values of at most 80 characters' using errcode = '22023';
  end if;
  if clean_status = 'published' and p_confirm_verified is not true then
    raise exception 'verification confirmation is required before publication' using errcode = '22023';
  end if;

  select coalesce(
    pg_catalog.array_agg(cleaned order by cleaned) filter (where cleaned <> ''),
    '{}'::text[]
  )
  into clean_keywords
  from (
    select distinct pg_catalog.btrim(value) as cleaned
    from pg_catalog.unnest(coalesce(p_keywords, '{}'::text[])) as keyword(value)
  ) normalized;

  if p_article_id is null then
    next_id := extensions.gen_random_uuid();
    insert into public.member_kb_articles (
      id, slug, kind, title, article_ref, body, keywords, order_index,
      chapter_id, status, is_sample, version, created_by, updated_by,
      verified_by, verified_at, updated_at
    )
    select
      next_id,
      'chapter-kb-' || pg_catalog.replace(next_id::text, '-', ''),
      clean_kind,
      clean_title,
      clean_ref,
      clean_body,
      clean_keywords,
      coalesce(pg_catalog.max(article.order_index), 0) + 1,
      caller_chapter,
      clean_status,
      false,
      1,
      caller,
      caller,
      case when clean_status = 'published' then caller else null end,
      case when clean_status = 'published' then pg_catalog.now() else null end,
      pg_catalog.now()
    from public.member_kb_articles article
    where article.chapter_id = caller_chapter
    returning * into saved;
  else
    select * into saved
    from public.member_kb_articles article
    where article.id = p_article_id
      and article.chapter_id = caller_chapter
      and not article.is_sample
    for update;

    if not found then
      raise exception 'knowledge article is not available in this chapter' using errcode = '42501';
    end if;

    -- The second publication route to a Storage-derived row. Editing or
    -- publishing language that came out of a file whose verdict has lapsed is
    -- refused here for exactly the reason restore_chapter_kb_revision refuses
    -- it, with the same SQLSTATE and the same message. Authored articles carry
    -- a null knowledge_source_id and stay editable.
    if not private.knowledge_source_verdict_current(saved.knowledge_source_id) then
      raise exception 'file inspection required' using errcode = '42501';
    end if;

    update public.member_kb_articles
       set kind = clean_kind,
           title = clean_title,
           article_ref = clean_ref,
           body = clean_body,
           keywords = clean_keywords,
           status = clean_status,
           version = version + 1,
           updated_by = caller,
           verified_by = case when clean_status = 'published' then caller else null end,
           verified_at = case when clean_status = 'published' then pg_catalog.now() else null end,
           updated_at = pg_catalog.now()
     where id = p_article_id
     returning * into saved;
  end if;

  insert into public.member_kb_article_revisions (
    article_id, chapter_id, version, status, kind, title, article_ref, body,
    keywords, changed_by, verified_by, verified_at,
    content_origin, knowledge_source_id
  ) values (
    saved.id, saved.chapter_id, saved.version, saved.status, saved.kind,
    saved.title, saved.article_ref, saved.body, saved.keywords, caller,
    saved.verified_by, saved.verified_at,
    case when saved.knowledge_source_id is null then 'authored' else 'derived' end,
    saved.knowledge_source_id
  );

  return saved;
end;
$function$;


create or replace function public.retire_chapter_kb_article(
  p_article_id uuid,
  p_chapter_id text default null
)
returns public.member_kb_articles
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.mi1_w2_selected_organization();
  home_chapter text := private.current_member_chapter();
  requested_chapter text := nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), '');
  caller_chapter text := coalesce(requested_chapter, home_chapter);
  saved public.member_kb_articles%rowtype;
  derived_lapsed boolean := false;
begin
  if caller is null
     or p_article_id is null
     or caller_chapter is null
     or not private.mi1_w2_same_org_chapter(org, caller_chapter)
     or not (
       private.mi1_knowledge_collection_staff(org)
       or (
         caller_chapter is not distinct from home_chapter
         and public.member_has_role(array['steward','coordinator','advisor','admin','vp'])
       )
     ) then
    raise exception 'knowledge article is not available in this chapter' using errcode = '42501';
  end if;

  select * into saved
  from public.member_kb_articles article
  where article.id = p_article_id
    and article.chapter_id = caller_chapter
    and not article.is_sample
  for update;

  if not found then
    raise exception 'knowledge article is not available in this chapter' using errcode = '42501';
  end if;

  -- Decided before anything is written, and read once so the answer and the
  -- projection below cannot disagree with each other.
  --
  -- The `for update` above locks the ARTICLE row. It does NOT serialize this
  -- read against a verdict change, and 20260906027000 claimed that it did.
  -- The verdict lives behind two rows this function never locks — the owning
  -- `storage.objects` row and its `private.private_upload_scans` ledger row —
  -- which is exactly why the two service-role completion RPCs take
  -- `select ... for update` on `storage.objects` through
  -- `private.knowledge_source_object_verdict_locked` before they write. What
  -- holds here is only ordinary statement-snapshot behaviour inside one
  -- transaction: both statements below see the same answer this one read.
  --
  -- That is sufficient because this path is removal-shaped and fail-closed in
  -- both directions. A verdict that lapses immediately after this read costs at
  -- most one already-authorized staff caller one already-visible copy of a row
  -- they were reading a moment earlier; a verdict that becomes current
  -- immediately after it costs at most one retirement returning less than it
  -- could have. Neither outcome publishes anything, and the retirement itself
  -- is written either way. Authored articles carry a null knowledge_source_id
  -- and answer true.
  derived_lapsed := not private.knowledge_source_verdict_current(saved.knowledge_source_id);

  update public.member_kb_articles
     set status = 'retired',
         version = version + 1,
         updated_by = caller,
         updated_at = pg_catalog.now()
   where id = p_article_id
   returning * into saved;

  insert into public.member_kb_article_revisions (
    article_id, chapter_id, version, status, kind, title, article_ref, body,
    keywords, changed_by, verified_by, verified_at,
    content_origin, knowledge_source_id
  ) values (
    saved.id, saved.chapter_id, saved.version, saved.status, saved.kind,
    saved.title, saved.article_ref, saved.body, saved.keywords, caller,
    saved.verified_by, saved.verified_at,
    case when saved.knowledge_source_id is null then 'authored' else 'derived' end,
    saved.knowledge_source_id
  );

  -- The read half. Retirement stays reachable during a lapse; the derived text
  -- does not cross the boundary with it. The stored row and the revision just
  -- written keep the content, and both are read only through gated surfaces.
  if derived_lapsed then
    saved.title := null;
    saved.article_ref := null;
    saved.body := null;
    saved.keywords := null;
  end if;

  return saved;
end;
$function$;


-- The SAMPLE seed writes literal strings from this repository, never Storage
-- bytes, so its revisions are authored. It is re-emitted rather than given a
-- column default: a default is exactly the mechanism that would let a future
-- writer classify derived text as authored by omission.
create or replace function private.demo_seed_apply_knowledge_library(p_lane text, p_run_id uuid)
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
        body, keywords, changed_by, verified_by, verified_at, changed_at,
        content_origin
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
        pg_catalog.now() - ((4 - version_number) || ' days')::interval,
        'authored'
      ) on conflict on constraint member_kb_article_revisions_article_id_version_key do update set
        status = excluded.status,
        content_origin = excluded.content_origin,
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

-- --------------------------------------------------------------------------
-- 7. Grants and contract comments.
--
-- `create or replace` preserves the ACL; every grant this migration touches is
-- re-stated so the surface is readable in one file.
-- --------------------------------------------------------------------------
revoke all on function public.replace_cba_knowledge_drafts(uuid, uuid, uuid, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.replace_cba_knowledge_drafts(uuid, uuid, uuid, text, jsonb)
  to service_role;
revoke all on function public.list_chapter_kb_revisions(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_chapter_kb_revisions(uuid, text)
  to authenticated;
revoke all on function public.restore_chapter_kb_revision(uuid, bigint, boolean, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.restore_chapter_kb_revision(uuid, bigint, boolean, uuid, text)
  to authenticated;
revoke all on function public.save_chapter_kb_article(
  uuid, text, text, text, text, text[], text, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.save_chapter_kb_article(
  uuid, text, text, text, text, text[], text, boolean, text
) to authenticated;
revoke all on function public.retire_chapter_kb_article(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.retire_chapter_kb_article(uuid, text)
  to authenticated;
revoke all on function private.demo_seed_apply_knowledge_library(text, uuid)
  from public, anon, authenticated, service_role;

comment on function public.replace_cba_knowledge_drafts(uuid, uuid, uuid, text, jsonb) is
  'Service-only, chapter-serialized CBA reconciliation re-establishes the originating object''s ledger verdict under its Storage row lock, then derives stable clause keys, preserves a collision-free contiguous agreement order range without versioning identical draft retries, keeps published and independently authored articles, clears stale candidates, and stages changed or missing verified clauses for explicit review. Every revision it writes records its content origin: candidates and canonical snapshots of a Storage-derived clause are ''derived'' and name the exact source.';
comment on function public.list_chapter_kb_revisions(uuid, text) is
  'Staff-only bounded revision history follows an explicit same-organization review chapter, with the current chapter retained as the legacy default. Each revision is gated on ITS OWN content source, unresolved-origin history is never listed, and contentOrigin is projected so a reviewer can see which rows are Storage-derived.';
comment on function public.restore_chapter_kb_revision(uuid, bigint, boolean, uuid, text) is
  'Idempotent explicit-chapter staff review can draft or verify imported changes, confirm retirement, or dismiss a proposed removal without changing canonical content. It refuses an unresolved-origin revision, refuses whenever the article''s or the candidate revision''s own originating Storage source has lost its current ledger verdict, sets the restored article''s provenance to the revision''s own content source instead of coalescing onto an unrelated current one, stores only content-free lifecycle metadata in its idempotency receipt, and reconstructs any replay through a current gated read bound to the original actor.';
comment on function public.save_chapter_kb_article(
  uuid, text, text, text, text, text[], text, boolean, text
) is
  'MFA-aware staff-only create/edit/publish path accepts only the current chapter or an explicitly selected same-organization chapter; every successful save appends an immutable revision that records the article''s content origin, so a staff edit of Storage-derived language stays derived; editing or publishing an article whose originating Storage source has lost its current ledger verdict is refused.';
comment on function public.retire_chapter_kb_article(uuid, text) is
  'Soft-retires a Compass source in the caller current chapter or an explicitly selected same-organization chapter authorized to organization staff; retirement stays reachable when the originating Storage source has lost its current ledger verdict, but the returned row then carries no title, article_ref, body or keywords. The appended revision records the article''s content origin.';
comment on function private.demo_seed_apply_knowledge_library(text, uuid) is
  'Private deterministic SAMPLE seed for CR-071 through CR-075; it creates no organization, user, provider credential, or delivery. Its knowledge revisions are literal strings shipped in a migration file with no Storage provenance, so they are recorded as authored.';

notify pgrst, 'reload schema';
commit;
