begin;

-- SEC-UG-CLEANROOM-UPLOAD-SECURITY-20260904 — slice 4, seventh repair.
--
-- Round-3 security review of 99e26d26 found ONE remaining path through which a
-- lapsed source's text stays listable and restorable: the omitted-clause
-- retirement candidate. This migration closes it, forward-only. No shipped
-- migration's executable content is edited.
--
-- ROUND-4 EDITED THIS FILE IN PLACE. The round-4 review of 5d637f2b found that
-- the legacy backfill below inferred content provenance from changed_at, which
-- is transaction-START time and therefore not serialization order. The file is
-- on the PR branch, is merged nowhere and has been applied to no database, so
-- it is corrected here rather than re-marked by a later migration: a follow-on
-- 030000 would leave the unsafe inference standing in the applied history of
-- any database that took 029000 first, and would attribute rows that must
-- never have been attributed. The correction is stated in full under "THE
-- EXACT BACKFILL PREDICATE" below.
--
-- ==========================================================================
-- P1. AN OMITTED-CLAUSE RETIREMENT CANDIDATE LAUNDERED SOURCE A ONTO SOURCE B
-- ==========================================================================
--
-- public.replace_cba_knowledge_drafts stages a version-zero retirement
-- candidate for every published clause that a REPLACEMENT agreement B omits.
-- That candidate is a COPY OF THE ARTICLE'S OWN CURRENT TEXT — title,
-- article_ref, body, keywords lifted straight off member_kb_articles — and the
-- article's text is derived from the source it currently carries, A. But
-- 20260906028000 stamped the candidate `knowledge_source_id = p_source_id`,
-- i.e. B, because B is the source whose reconciliation PROPOSED the removal.
--
-- Content provenance and decision provenance are not the same fact, and
-- conflating them re-opened the round-1 escape on this one branch:
--
--   1. A publishes a clause. The article and its canonical history are on A.
--   2. B arrives without that clause. A retirement candidate is staged holding
--      A's text but naming B.
--   3. A reviewer confirms the retirement. restore_chapter_kb_revision copies
--      the candidate's A-derived text onto the article, sets the article's
--      provenance to the candidate's own source — B — and writes a canonical
--      retirement revision that also names B.
--   4. A goes stale, blocked, failed or deleted. B stays current.
--   5. Every gate consults B and answers true. A-derived text is listed by
--      list_chapter_kb_revisions and republished by restore_chapter_kb_revision.
--
-- THE FIX SEPARATES THE TWO FACTS INTO TWO COLUMNS.
--
--   knowledge_source_id      — WHERE THE TEXT CAME FROM. On a retirement
--                              candidate STAGED BY THE WRITER BELOW this is the
--                              ARTICLE'S OWN current source (A), read under the
--                              article's own row lock, because the candidate's
--                              bytes were copied off the article. content_origin
--                              stays 'derived', so the row is gated on A. On a
--                              LEGACY candidate the same fact was never
--                              recorded, so the backfill withholds it instead
--                              of guessing; see the round-4 correction.
--   reconciled_by_source_id  — WHICH RECONCILIATION STAGED THIS CANDIDATE (B).
--                              New, nullable, `references
--                              public.organization_knowledge_sources(id) on
--                              delete restrict`, and constrained so ONLY a
--                              version-zero candidate may carry it — and so
--                              every version-zero candidate MUST carry it, in
--                              the same "state it, never default it" spirit as
--                              content_origin.
--
-- CHANGED-CLAUSE CANDIDATES ARE UNCHANGED. A changed-clause candidate holds
-- B's OWN normalized text, so B is both its content source and its reconciler;
-- its knowledge_source_id stays p_source_id and its content_origin stays
-- 'derived'. It gains reconciled_by_source_id = p_source_id as well, so that
-- "candidates staged by this source" is ONE predicate over BOTH candidate kinds
-- rather than a coalesce.
--
-- AUDIT: WHAT ACTUALLY READ A CANDIDATE'S knowledge_source_id AS "THE SOURCE
-- THAT STAGED IT". Enumerated over every relation and function at this head
-- that touches a version-zero row, not inferred:
--
--   * The stale-candidate cleanup inside replace_cba_knowledge_drafts
--     (`version = 0 and import_candidate_key is not null`, scoped to the one
--     article the loop is holding `for update`) is keyed by ARTICLE, not by
--     source. Unchanged, and it still clears a candidate of any origin —
--     including an 'unresolved' one — so a later reconciliation is never
--     blocked by a row this migration could not attribute.
--   * The candidate upsert is `on conflict (article_id, version)`, keyed by
--     article and the single version-zero slot. It rewrites content_origin,
--     knowledge_source_id AND reconciled_by_source_id, so re-ingest always
--     overwrites the slot completely, whatever it held before.
--   * public.list_chapter_kb_revisions reads version-zero rows through the same
--     per-revision gate as canonical ones. Its intent is CONTENT provenance, so
--     it keeps reading knowledge_source_id — which is now A for a retirement
--     candidate staged since this migration, which is the whole point, and
--     which a legacy withheld candidate does not reach at all: the
--     `content_origin <> 'unresolved'` conjunct drops it first. It
--     additionally projects
--     `reconciledBySourceId` so a reviewer can see which agreement proposed the
--     removal without that fact having to live in the content column.
--   * public.restore_chapter_kb_revision reads the candidate's
--     knowledge_source_id for the verdict gate and for `restored_source`. Both
--     are CONTENT questions, so both are correct once the column holds A.
--   * public.list_knowledge_review_articles_snapshot projects
--     member_kb_articles only ({id, chapterId, title, articleRef, status,
--     version, orderIndex}); it never reads member_kb_article_revisions, so no
--     count or snapshot it returns depends on a candidate's source.
--   * public.retry_knowledge_ingest_source and
--     public.clear_knowledge_ingest_source_chunks touch
--     organization_knowledge_sources / _chunks / _files only; neither names
--     member_kb_article_revisions. There is no source-deletion RPC at this
--     head: organization_knowledge_sources rows are protected by `on delete
--     restrict` from member_kb_articles.knowledge_source_id and
--     member_kb_article_revisions.knowledge_source_id already, and
--     reconciled_by_source_id adds the same restriction for the reconciling
--     source, which previously held through the candidate's knowledge_source_id.
--     The set of undeletable sources is therefore unchanged.
--   * The SAMPLE seed and its verifier/remover address revisions by ARTICLE id
--     only and write no candidates.
--   * The reconciliation counters (publishedCandidatesStaged,
--     publishedRetirementsStaged, staleCandidatesCleared, draftsRetired) are
--     loop/row counters, not queries over a candidate's source.
--
-- CONFIRMATION SEMANTICS, STATED SO THEY ARE NOT REDISCOVERED LATER.
-- Confirming a retirement candidate now keeps the article on A
-- (`restored_source` is the candidate's OWN content source) and writes the
-- canonical retirement revision as 'derived' from A. Consequently, once A has
-- lapsed the confirmation is REFUSED with 42501 'file inspection required',
-- exactly like any other publication of lapsed text: the candidate's own
-- verdict gate in restore_chapter_kb_revision fails. The DISMISS path is
-- refused for the same reason and deliberately so — dismissal returns
-- to_jsonb(article), which is content. Staff are not stuck:
-- public.retire_chapter_kb_article remains reachable during a lapse and returns
-- a body-free row (20260906027000), so the article can still be retired for
-- cleanup while the derived text stays behind the gate.
--
-- That paragraph is about candidates staged FROM NOW ON, whose content source
-- the writer records under the article's own row lock. A LEGACY candidate that
-- the backfill below withholds is stricter still: it is 'unresolved', so it is
-- not listed at all and BOTH the confirm and the dismiss path answer P0002
-- 'not found' — the same answer a revision that is not there gets, because
-- distinguishing them would turn the RPC into an oracle for withheld history.
-- The same cleanup route applies and the same next reconciliation replaces the
-- slot.
--
-- ==========================================================================
-- THE EXACT BACKFILL PREDICATE — AND WHY NO TIMESTAMP APPEARS IN IT
-- ==========================================================================
--
-- The hosted databases have applied no 202609060xxxxx migration, so this runs
-- once against real history. Every candidate is classified from facts recorded
-- ON THE ROW ITSELF by the writer that wrote it; anything a row does not prove
-- is withheld rather than guessed.
--
-- ROUND-4 CORRECTION: A TIMESTAMP IS NOT SERIALIZATION ORDER.
-- The first draft of this migration called a retirement candidate attributable
-- when no positive-version revision of its article carried
-- `changed_at >= the candidate's changed_at`, reading that as "the article's
-- source has not moved since the candidate was staged". That is not a proof.
-- changed_at defaults to now() (20260812110000_chapter_compass_knowledge.sql),
-- and PostgreSQL fixes now() at TRANSACTION START — not at lock acquisition,
-- not at commit. A source-moving transaction can therefore BEGIN FIRST, block
-- on the article row while the candidate transaction holds it, and commit
-- AFTERWARDS, leaving behind a canonical revision whose changed_at is EARLIER
-- than the candidate's. public.restore_chapter_kb_revision on a positive
-- version is exactly such a transaction: it takes the article `for update`,
-- moves the article's knowledge_source_id, deletes the version-zero candidate
-- ONLY when the selected revision IS that candidate, and appends a canonical
-- revision. Under that interleaving the old predicate would have stamped text
-- copied under source A with the article's later source C; once A lapsed while
-- C stayed current, C's live verdict would gate A's text and the very
-- laundering this migration exists to remove would be back.
--
-- AND NO OTHER ORDERING FACT ON THESE ROWS IS DEMONSTRABLY SAFE EITHER:
-- xmin is recycled by wraparound and frozen by vacuum, ctid is physical
-- location, id is a random uuid, and no sequence, commit timestamp
-- (track_commit_timestamp is off) or per-article history log exists at the base
-- head. There is nothing to substitute, so this migration does not substitute
-- anything. THE CLASSIFIER READS `version`, `status`, `import_candidate_key`
-- AND `knowledge_source_id`, AND NOTHING ELSE. No timestamp column, no
-- transaction id, no clock function appears anywhere in it.
--
-- A. EVERY LEGACY RETIREMENT-SHAPED CANDIDATE IS WITHHELD (version 0, status
--    'retired'). It becomes content_origin 'unresolved' with a NULL
--    knowledge_source_id, and the ONE fact about it that was actually written
--    down moves into reconciled_by_source_id: the value the pre-repair writer
--    stamped in knowledge_source_id, which is p_source_id — the REPLACEMENT
--    agreement whose reconciliation proposed the removal, i.e. the DECISION
--    source. That much is provable from the writer: the retirement branch of
--    20260906028000's replace_cba_knowledge_drafts is the only writer of a
--    version-zero row with status 'retired', and it always stamped p_source_id
--    there.
--
--    The CONTENT source is not provable and is therefore not named. The
--    candidate's title, article_ref, body and keywords were copied off
--    member_kb_articles at stage time, under whatever source the article
--    carried at that instant, and NOTHING on any row records which source that
--    was. The article's source column today may or may not still be it, and —
--    per the round-4 correction above — no timestamp on these rows can tell
--    the two cases apart. So the row is withheld: an 'unresolved' candidate is
--    excluded outright by public.list_chapter_kb_revisions and refused P0002
--    by public.restore_chapter_kb_revision (20260906028000), which means it can
--    neither be listed, confirmed nor dismissed, and it can never re-publish
--    one source's language under another's provenance.
--
--    This is a strict superset of what the timestamp predicate would have
--    withheld, so nothing that predicate called unattributable becomes
--    attributable here, and the two cases it called attributable — a genuinely
--    unmoved article, and the inverted-order article it misread — now land in
--    the same conservative place. Identifying the exact writer through
--    md5('retire:' || … ) is consequently no longer part of the classification:
--    a retirement-shaped row and a row of unrecognised shape are treated
--    identically, so there is nothing left for the shape test to decide.
--
-- B. CHANGED-CLAUSE CANDIDATES KEEP 'derived' ON THEIR OWN SOURCE (version 0,
--    status 'draft'). reconciled_by_source_id := knowledge_source_id, and
--    nothing else about the row changes. THE WRITER INSERTED p_source_id'S OWN
--    TEXT: the changed-clause branch is the only writer of a version-zero row
--    with status 'draft', and every text value it inserts (clean_title,
--    clean_ref, clean_body, clean_keywords) comes out of the p_articles payload
--    normalized from p_source_id's own inspected bytes — not off the article —
--    while it stamps knowledge_source_id = p_source_id. Content provenance and
--    decision provenance are the SAME source here, and the content claim
--    follows from the writer alone: no later movement of the article can change
--    which file those bytes came out of, so no ordering fact is needed and none
--    is consulted.
--
-- C. EVERY REMAINING VERSION-ZERO ROW IS WITHHELD ON THE SAME TERMS. A row
--    that is neither of the two shapes above was written by something this
--    migration cannot name, so it becomes 'unresolved' with a null
--    knowledge_source_id and keeps whichever source value it carried as its
--    decision source — the only fact about it ever written down.
--
--    member_kb_article_revisions_version_shape (20260903030000) makes
--    `version = 0` and `import_candidate_key is not null` the same set, and
--    20260906028000's member_kb_article_revisions_candidate_is_derived — still
--    in force on the hosted databases when this file runs — requires every such
--    row to carry a non-null knowledge_source_id. So every row the three
--    UPDATEs touch has both, which is why the iff constraint added afterwards
--    can hold and why the decision column is never left null on a candidate.
--    It is also why the old constraint is dropped BEFORE the first backfill
--    statement: a check written for the pre-repair shape would otherwise abort
--    the very transaction that repairs it, on the first candidate withheld —
--    which is now every retirement candidate on the database.
--
-- D. WITHHOLDING IS NOT A PERMANENT BLOCK, AND IT COSTS NO EVIDENCE. The
--    withheld row is retained: the revision table is the immutable record of
--    what was staged, and deleting evidence is not a security fix. The
--    stale-candidate cleanup inside replace_cba_knowledge_drafts is keyed by
--    ARTICLE and clears a candidate of ANY origin, and the candidate upsert is
--    `on conflict (article_id, version)` and rewrites content_origin,
--    knowledge_source_id AND reconciled_by_source_id together, so THE NEXT
--    RECONCILIATION OF THAT CHAPTER OVERWRITES THE SLOT COMPLETELY with a
--    candidate whose provenance is proven by the writer that wrote it. Until
--    then the article itself is untouched and fully usable: it keeps its own
--    status, text and source, it is still listed, still editable through
--    save_chapter_kb_article, and still retirable through
--    public.retire_chapter_kb_article. The only thing withdrawn is the one
--    unprovable claim.
--
-- E. NO CONSTRAINT IS LOOSENED TO ALLOW THIS. The shape the backfill writes is
--    exactly what the three replacement constraints admit and no more:
--    candidate_origin_known allows a candidate to be ('derived', non-null
--    source) or ('unresolved', null source) and nothing else — an 'authored'
--    candidate, a derived candidate with no source and an unresolved candidate
--    that still names one are all rejected; unresolved_names_no_source repeats
--    the null-source half at EVERY version so no future writer can name a
--    source on a withheld row; reconciled_by_is_candidate is an iff, so only a
--    candidate may carry a decision source and every candidate must.
--
-- Invariants are unchanged. private.private_upload_is_current remains the one
-- expression consulted (invariant 7) through
-- private.knowledge_source_verdict_current; organization_knowledge_files.
-- scan_status is still not read; no caller supplies a path, bucket, digest or
-- verdict (invariant 1); authored content and non-Storage sources keep their
-- semantics (invariant 6).

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- --------------------------------------------------------------------------
-- 1. The decision-source column, its backfill and its shape constraints.
-- --------------------------------------------------------------------------
-- Nullable with no default, for the same reason content_origin has no default:
-- a future writer must state which reconciliation staged a candidate, never
-- inherit it.
alter table public.member_kb_article_revisions
  add column reconciled_by_source_id uuid
    references public.organization_knowledge_sources(id) on delete restrict;

-- WIDEN BEFORE WITHHOLDING. 20260906028000's
-- member_kb_article_revisions_candidate_is_derived says a row carrying an
-- import_candidate_key must be 'derived' with a non-null knowledge_source_id,
-- and the backfill below deliberately writes ('unresolved', null) onto exactly
-- such rows. On an empty table that never matters, which is precisely why no
-- gate in this repository could see it; on real history it aborts the whole
-- transaction on the first candidate this migration cannot attribute — the
-- case the header exists to handle. The drop therefore precedes every UPDATE.
-- The three replacement constraints stay AFTER the backfill: two of them
-- describe shapes the backfill is still creating, and
-- member_kb_article_revisions_reconciled_by_is_candidate cannot hold at all
-- until every candidate carries the new column.
alter table public.member_kb_article_revisions
  drop constraint member_kb_article_revisions_candidate_is_derived;

-- Retirement-shaped candidates: EVERY one is withheld. The value the
-- pre-repair writer put in the content column is the RECONCILING agreement, so
-- it moves to the decision column; the content column is cleared, because
-- which source the copied text actually came from is not recorded anywhere and
-- no timestamp on these rows can establish it (see the round-4 correction in
-- the header). SET reads the OLD row, so the move and the clear are one
-- statement.
update public.member_kb_article_revisions revision
set reconciled_by_source_id = revision.knowledge_source_id,
    knowledge_source_id = null,
    content_origin = 'unresolved'
where revision.version = 0
  and revision.status = 'retired'
  and revision.import_candidate_key is not null
  and revision.knowledge_source_id is not null;

-- Changed-clause candidates: the writer inserted p_source_id's OWN normalized
-- text and stamped p_source_id, so that one source is both the content source
-- and the reconciler. Nothing else about the row changes.
update public.member_kb_article_revisions revision
set reconciled_by_source_id = revision.knowledge_source_id
where revision.version = 0
  and revision.status = 'draft'
  and revision.import_candidate_key is not null
  and revision.knowledge_source_id is not null
  and revision.reconciled_by_source_id is null;

-- Any version-zero row this migration cannot place in either branch is
-- withheld on the same terms. It keeps whichever source value it carried in
-- the decision column, because that is the only fact about it that was ever
-- written down.
update public.member_kb_article_revisions revision
set reconciled_by_source_id = coalesce(revision.reconciled_by_source_id, revision.knowledge_source_id),
    knowledge_source_id = null,
    content_origin = 'unresolved'
where revision.version = 0
  and revision.reconciled_by_source_id is null;

alter table public.member_kb_article_revisions
  add constraint member_kb_article_revisions_candidate_origin_known
    check (
      import_candidate_key is null
      or (content_origin = 'derived' and knowledge_source_id is not null)
      or (content_origin = 'unresolved' and knowledge_source_id is null)
    ),
  add constraint member_kb_article_revisions_unresolved_names_no_source
    check (content_origin <> 'unresolved' or knowledge_source_id is null),
  add constraint member_kb_article_revisions_reconciled_by_is_candidate
    check (
      (reconciled_by_source_id is not null) = (import_candidate_key is not null)
    );

comment on column public.member_kb_article_revisions.reconciled_by_source_id is
  'DECISION provenance, never content provenance: the organization_knowledge_sources row whose reconciliation staged this version-zero candidate. Set on every candidate and only on candidates. A retirement candidate staged since this migration copies the ARTICLE''s text, so its knowledge_source_id names the article''s own source and this column names the replacement agreement that proposed the removal; a changed-clause candidate carries the replacement''s own text, so both columns name it. On a LEGACY candidate withheld by this migration''s backfill this column holds the only provenance that was ever recorded — the reconciling source — and knowledge_source_id is null, because which source the copied text came from was never written down and no timestamp on these rows can establish it.';

comment on column public.member_kb_article_revisions.content_origin is
  'Explicit content-origin discriminator: authored (staff-typed, null knowledge_source_id), derived (lifted from an inspected Storage object, knowledge_source_id names the exact source the TEXT came from and gates the row), or unresolved (historical row whose true origin cannot be proved; knowledge_source_id is null, and the row is never listed, returned or republished, and never treated as authored). For a version-zero retirement candidate staged since 20260906029000 the text is copied off the article, so knowledge_source_id is the article''s own source and reconciled_by_source_id records the reconciliation that staged it; every LEGACY candidate of that shape was withheld as unresolved instead, because its content source was never recorded.';

-- "Which candidates did this reconciliation stage" is now one predicate over
-- one column, so give it an index rather than leaving it to a sequential scan
-- of every revision ever written.
create index if not exists member_kb_article_revisions_reconciled_by_idx
  on public.member_kb_article_revisions (reconciled_by_source_id)
  where reconciled_by_source_id is not null;

-- --------------------------------------------------------------------------
-- 2. CBA reconciliation: the retirement candidate keeps the article's own
--    content provenance and records B separately.
--
-- Re-emitted whole rather than patched, so the one file a reader opens is the
-- current definition. The only executable differences from 20260906028000 are
-- the two candidate inserts.
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
          -- A CHANGED clause candidate carries the REPLACEMENT's own
          -- normalized text, so p_source_id is both where the bytes came from
          -- and which reconciliation staged the row. Both columns name it, and
          -- this branch is unchanged from 20260906028000 apart from recording
          -- the decision source explicitly instead of leaving it implied.
          insert into public.member_kb_article_revisions (
            article_id, chapter_id, version, status, kind, title, article_ref,
            body, keywords, changed_by, verified_by, verified_at,
            import_candidate_key, knowledge_source_id, reconciled_by_source_id,
            content_origin
          ) values (
            current_article.id, current_article.chapter_id, 0,
            'draft', current_article.kind, clean_title, clean_ref, clean_body,
            clean_keywords, p_actor_user_id, null, null, candidate_key,
            p_source_id, p_source_id,
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
            reconciled_by_source_id = excluded.reconciled_by_source_id,
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
    -- THE ROUND-3 REPAIR. Every value below except changed_by and the key is
    -- copied off current_article, so the TEXT is derived from the article's own
    -- source and knowledge_source_id must name that source, not p_source_id.
    -- current_article.knowledge_source_id is non-null by construction: this
    -- loop joins it to a protected contract source in this chapter.
    -- p_source_id — the agreement that proposed the removal — is recorded in
    -- reconciled_by_source_id, and candidate_key already binds the row to it.
    insert into public.member_kb_article_revisions (
      article_id, chapter_id, version, status, kind, title, article_ref,
      body, keywords, changed_by, verified_by, verified_at,
      import_candidate_key, knowledge_source_id, reconciled_by_source_id,
      content_origin
    ) values (
      current_article.id, current_article.chapter_id, 0,
      'retired', current_article.kind, current_article.title,
      current_article.article_ref, current_article.body,
      current_article.keywords, p_actor_user_id, null, null,
      candidate_key, current_article.knowledge_source_id, p_source_id,
      'derived'
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
      reconciled_by_source_id = excluded.reconciled_by_source_id,
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
-- 3. Revision history projects the decision source alongside the content one.
--
-- The gate itself is unchanged: each row is still gated on ITS OWN
-- knowledge_source_id — which for a retirement candidate is now the article's
-- source — and unresolved rows are still excluded outright. What changes is
-- that a reviewer looking at a proposed removal can see WHICH agreement
-- proposed it without that fact having to be smuggled into the content column.
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
      'reconciledBySourceId', revision.reconciled_by_source_id,
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
-- 4. Grants and contract comments.
--
-- `create or replace` preserves the ACL; both grants are re-stated so the
-- surface is readable in one file. No other function's definition, grant or
-- signature changes in this migration: public.restore_chapter_kb_revision is
-- already correct once the candidate carries the article's own source — it
-- gates on `revision.knowledge_source_id` and sets `restored_source` from the
-- revision's own content source — so it is deliberately NOT re-emitted here.
-- --------------------------------------------------------------------------
revoke all on function public.replace_cba_knowledge_drafts(uuid, uuid, uuid, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.replace_cba_knowledge_drafts(uuid, uuid, uuid, text, jsonb)
  to service_role;
revoke all on function public.list_chapter_kb_revisions(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_chapter_kb_revisions(uuid, text)
  to authenticated;

comment on function public.replace_cba_knowledge_drafts(uuid, uuid, uuid, text, jsonb) is
  'Service-only, chapter-serialized CBA reconciliation re-establishes the originating object''s ledger verdict under its Storage row lock, then derives stable clause keys, preserves a collision-free contiguous agreement order range without versioning identical draft retries, keeps published and independently authored articles, clears stale candidates, and stages changed or missing verified clauses for explicit review. Every revision it writes states its content origin explicitly. Since 20260906029000 CONTENT provenance and DECISION provenance are separate columns: a changed-clause candidate carries the replacement''s own text and names it in both, while a retirement candidate copies the ARTICLE''s text and therefore keeps the article''s own knowledge_source_id, recording the reconciling agreement in reconciled_by_source_id. Confirming a retirement consequently keeps the article on its own source and is refused once that source lapses, instead of republishing one source''s text under another''s provenance.';
comment on function public.list_chapter_kb_revisions(uuid, text) is
  'Staff-only bounded revision history follows an explicit same-organization review chapter, with the current chapter retained as the legacy default. Each revision is gated on ITS OWN content source, unresolved-origin history is never listed, and contentOrigin plus reconciledBySourceId are projected so a reviewer can see which rows are Storage-derived and which agreement proposed a staged removal.';

notify pgrst, 'reload schema';
commit;
