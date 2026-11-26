begin;

-- SEC-UG-CLEANROOM-UPLOAD-SECURITY-20260904 — slice 4, eighth repair.
--
-- An adversarial red-team pass over d5adc33c found the provenance repair was
-- REVISION-ONLY. 20260906028000 and 20260906029000 gave
-- public.member_kb_article_revisions an explicit content origin and backfilled
-- it, withholding every row whose true source this schema cannot prove. Neither
-- migration — nor any of the other ten this record ships — contains a single
-- top-level statement against public.member_kb_articles. The live article row,
-- which is the copy every member-facing gate actually serves, was left gated on
-- the one inference those two migrations exist to remove.
--
-- ==========================================================================
-- P1. THE ARTICLE ROW KEEPS A SOURCE THAT DID NOT PRODUCE ITS TEXT
-- ==========================================================================
--
-- The producing writers are on the base head (20260903030000, shipped on Main),
-- so a hosted database can already hold the corrupted row before any migration
-- of this record runs. Both routes end in the same place:
--
--   1. Source A imports clause X and a reviewer publishes it. Every canonical
--      revision holds A's text with a null source, because
--      member_kb_article_revisions_import_candidate_complete was an EQUALITY
--      and member_kb_article_revisions_version_shape forces a positive version
--      to carry a null import_candidate_key.
--   2. Replacement agreement B stages a version-zero changed-clause candidate.
--      A reviewer restores it: the article moves to B, holding B's text.
--   3. The reviewer changes their mind and restores the older canonical
--      revision — the ordinary "revert to the previous version" action. That
--      revision's source is null, so
--      `knowledge_source_id = coalesce(revision.knowledge_source_id,
--      article.knowledge_source_id)` (20260903030000:868) evaluates to B while
--      the body written is A's text.
--
--   The retirement variant needs no revert at all: when B OMITS the clause, the
--   base-head writer stages a retirement candidate that COPIES the article's
--   own A-derived text while stamping p_source_id = B (20260903030000:646-670),
--   and confirming it drives the same :868 update.
--
--   END STATE: member_kb_articles.body is A's text, member_kb_articles.
--   knowledge_source_id is B. Once A lapses — never re-inspected, blocked,
--   deleted, or simply past clean_until — while B stays current, EVERY
--   article-level gate reads B, answers true, and serves A's text:
--   list_accessible_knowledge_articles_snapshot (the member Library/Search read
--   that returns the clause BODY and requires no staff role), both RLS read
--   policies on the table `authenticated` selects directly, search_member_kb
--   (Compass retrieval), list_knowledge_review_articles_snapshot,
--   list_knowledge_collections, save_chapter_kb_article (which will re-publish
--   it), retire_chapter_kb_article, and list_chapter_kb_revisions' article-level
--   precondition. The revision table simultaneously declares that same text
--   'unresolved'. One row, two answers.
--
-- ==========================================================================
-- THE REPAIR IS THE SAME RULE, APPLIED WHERE IT WAS MISSING
-- ==========================================================================
--
-- public.member_kb_articles.content_origin, `not null`, with NO DEFAULT — a
-- default is precisely how a future writer would classify derived text as
-- authored by omission — taking the same three values the revision table uses,
-- with constraints that mirror it:
--
--   'authored'   — staff-typed, or a literal string shipped in a migration.
--                  Requires a null knowledge_source_id.
--   'derived'    — lifted out of an inspected Storage object. Requires a
--                  NON-NULL knowledge_source_id naming the exact source, so the
--                  row is gated on its OWN provenance.
--   'unresolved' — a historical row whose true origin this migration cannot
--                  prove. It KEEPS whatever knowledge_source_id it carries,
--                  because that value is real history and deleting evidence is
--                  not a security fix — but that value gates nothing, and the
--                  row is never listed, returned, edited, published or retired.
--
-- THE EXACT BACKFILL PREDICATE. The hosted databases have applied no
-- 202609060xxxxx migration, so this runs once against real history. Only what
-- the schema PROVES is classified; everything else is withheld.
--
--   knowledge_source_id is null AND import_key is null AND no revision of the
--   article carries a non-null knowledge_source_id  ->  'authored'.
--       This is the article-level statement of the monotonicity argument
--       20260906028000 already records and this migration does not re-derive:
--       member_kb_articles.knowledge_source_id is MONOTONE at the base head.
--       replace_cba_knowledge_drafts only ever sets it to a non-null source;
--       the old restore wrote coalesce(revision.knowledge_source_id,
--       article.knowledge_source_id), which cannot produce null from a non-null
--       article value; save_chapter_kb_article and retire_chapter_kb_article
--       never mention the column; no shipped migration sets it back to null.
--       A null today therefore proves it was null for the whole life of the
--       row, which proves no writer ever copied Storage-derived text into it —
--       all five writers copy the article's own current text. The third
--       conjunct is the same belt-and-braces the revision backfill uses: a
--       candidate row is the only place this schema has ever recorded a source,
--       so an article that has never carried one and has never had one staged
--       against it has no Storage lineage at all.
--
--       SAMPLE and seeded repository articles satisfy exactly this predicate on
--       their own merits, by the ordinary rule rather than a special case:
--       private.demo_seed_apply_knowledge_library and the literal seed rows in
--       20260722130441 write strings that live in shipped migration files and
--       set no source, so nothing about them came out of Storage bytes and
--       nothing about them can be re-inspected.
--
--   EVERY OTHER ARTICLE  ->  'unresolved'. In practice, by
--   member_kb_articles_import_provenance_complete, that is every article that
--   carries a non-null knowledge_source_id.
--
--       THIS IS DELIBERATELY EVERY LEGACY DERIVED ARTICLE, NOT A SUBSET.
--       Nothing in this schema distinguishes a laundered article from an honest
--       one. The article's text is not recorded on any row alongside the source
--       that produced it; the knowledge_source_retried audit event carries
--       sourceId but no articleId, and knowledge_revision_restored carries
--       articleId but no sourceId; and every legacy positive-version revision
--       of such an article was itself classified 'unresolved' by
--       20260906028000, so the revision table cannot tell them apart either.
--       "Its current source is probably right" is the coalesce defect this
--       record exists to remove, and a probability is not a proof. So the claim
--       is withdrawn for all of them and re-established, per article, only by a
--       reviewed reconciliation from a file that has actually been inspected.
--
--       NULLING knowledge_source_id INSTEAD WOULD BE THE OPPOSITE OF A REPAIR:
--       private.knowledge_source_verdict_current answers TRUE for a null source
--       by design (invariant 6), so a null would make the row MORE visible, not
--       less. That is why the withholding is an explicit discriminator and why
--       the source value stays on the row.
--
-- ==========================================================================
-- ONE PREDICATE, AND EVERY ARTICLE-LEVEL GATE ROUTED THROUGH IT
-- ==========================================================================
--
-- private.knowledge_article_content_current(article) is true only for an
-- authored article and for a derived article whose OWN source holds a current
-- ledger verdict, and false for a withheld one. Every gate below reads that one
-- expression instead of private.knowledge_source_verdict_current(
-- article.knowledge_source_id), which is now reached only THROUGH it. The
-- surfaces were enumerated from the live catalog rather than from a scan of
-- migration files — every pg_proc body and every pg_policy that names
-- public.member_kb_articles at this head:
--
--   READ / SERVE (a withheld row is simply absent)
--     public.list_accessible_knowledge_articles_snapshot   member Library/Search
--     policy member_kb_articles_member_read                direct PostgREST select
--     policy member_kb_articles_staff_read                 direct PostgREST select
--     public.search_member_kb                              Compass retrieval
--     public.list_knowledge_collections                    collection projection
--     public.set_knowledge_collection_item                 placement (ADD only)
--     public.list_knowledge_review_articles_snapshot       staff review listing
--   WRITE / PUBLISH (a withheld row answers as an absent one)
--     public.save_chapter_kb_article        42501 'knowledge article is not
--                                           available in this chapter'
--     public.retire_chapter_kb_article      the same 42501
--     public.list_chapter_kb_revisions      P0002 'not found'
--     public.restore_chapter_kb_revision    P0002 'not found'
--     private.knowledge_revision_restore_receipt  P0002 'not found'
--   WRITERS THAT STATE THE ORIGIN THEY CREATE
--     public.replace_cba_knowledge_drafts   'derived', with the source
--     private.demo_seed_apply_knowledge_library  'authored'
--
-- NO REFUSAL IS AN ORACLE. Each refusal is the shape that surface ALREADY uses
-- for an article that is not there, so a caller cannot tell a withheld article
-- from an absent one — exactly the rule 20260906028000 adopted for withheld
-- revisions. The one shape that is NOT reused is 42501 'file inspection
-- required': that answer means "this text exists and its file must be
-- inspected", which is a fact about a row this record is refusing to describe.
-- It stays reserved for a DERIVED article whose named source has lapsed, whose
-- provenance is not in doubt.
--
-- private.demo_seed_knowledge_library_status and
-- private.demo_seed_remove_knowledge_library also name the table and are
-- deliberately unchanged: they are granted to no role, they address SAMPLE rows
-- by deterministic id, and they serve no member or staff read.
--
-- ==========================================================================
-- RE-ESTABLISHMENT: THE ONE DOOR OUT, AND WHAT IT COSTS UNTIL SOMEONE USES IT
-- ==========================================================================
--
-- A withheld article resurfaces ONLY through a reviewed reconciliation from an
-- inspected source. public.replace_cba_knowledge_drafts now treats a withheld
-- article whose import_key matches an incoming clause as CHANGED — even when
-- the incoming text is byte-identical to what the row holds — and stages the
-- ordinary version-zero changed-clause candidate carrying THE INCOMING SOURCE'S
-- OWN normalized bytes and naming that source in both provenance columns. A
-- reviewer restores it through the unchanged workflow, and
-- restore_chapter_kb_revision sets the article's origin from the revision it
-- restored: 'derived', on the file the text now actually came from.
--
-- Comparing text and skipping would be the wrong test. Byte-identity between a
-- withheld article and an incoming clause proves nothing about where the
-- article's bytes came from — that is the whole content of the finding — so the
-- equality is not allowed to decide anything here.
--
-- private.knowledge_article_reestablishment_candidate is that door, written
-- once: for a WITHHELD article it returns the version-zero candidate whose own
-- content_origin is 'derived' and whose own source holds a current verdict, and
-- for anything else it returns nothing. list_chapter_kb_revisions and
-- list_knowledge_review_articles_snapshot admit a withheld article only when it
-- opens, and restore_chapter_kb_revision accepts only that exact revision. No
-- withheld text crosses the boundary when it does: the candidate's title,
-- article_ref, body and keywords are the incoming agreement's own inspected
-- text, and the review listing projects THE CANDIDATE's naming for such a row
-- rather than the withheld article's, with contentWithheld: true beside it.
--
-- THE COST, STATED RATHER THAN DISCOVERED. Until that reconciliation runs, a
-- withheld clause looks to a member exactly like a clause that was never
-- imported: absent from the Library, absent from Compass answers, absent from
-- the collection it was placed in. Staff see the same absence and cannot edit,
-- publish or retire it. That is the intended trade: this record's rule is that
-- unattributable text is withheld rather than served, and the article row is
-- the copy members actually read.
--
-- HOSTED FIRST APPLY. Because the hosted databases have applied no
-- 202609060xxxxx migration, this backfill runs once, on cutover, against real
-- history — and its consequence now reaches ARTICLE rows, not only revisions
-- and catalog files: every member_kb_articles row that carries a
-- knowledge_source_id at that moment becomes withheld in the same transaction
-- that adds the column, and stays withheld until its chapter is reconciled from
-- an inspected contract file. On SAMPLE the seeded knowledge corpus carries no
-- knowledge_source_id at all, so it classifies 'authored' and is untouched; the
-- derived half of SAMPLE is created by the activation plan's re-seed (E6), which
-- runs through the inspected path and therefore writes 'derived' rows from the
-- start. docs/security/private-upload-inspection.md records the same
-- consequence in its hosted-cutover section.
--
-- Invariants are unchanged. private.private_upload_is_current remains the one
-- expression consulted (invariant 7), now reached through
-- private.knowledge_article_content_current -> private.
-- knowledge_source_verdict_current; organization_knowledge_files.scan_status is
-- still not read; no caller supplies a path, bucket, digest or verdict
-- (invariant 1); an authored article and a non-Storage source keep their
-- semantics exactly (invariant 6).

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- --------------------------------------------------------------------------
-- 1. The article-level discriminator, its backfill and its shape constraints.
--
-- STATEMENT ORDER IS LOAD-BEARING, AS 20260906029000 LEARNED THE HARD WAY.
-- The column is added NULLABLE and with NO DEFAULT so the backfill below is the
-- only thing that can decide an existing row's origin and so no future insert
-- can omit the column and be silently classified; `set not null` and every
-- shape constraint land only AFTER the two backfill statements have given every
-- row a value. On an empty database the order would never matter, which is
-- exactly why a gate in this repository could not see the equivalent mistake
-- last round; the live twin is the regression in
-- tests/private-file-workflow-gates-db.test.js, which replays this section over
-- real pre-migration history.
-- --------------------------------------------------------------------------
alter table public.member_kb_articles
  add column content_origin text;

-- Provable from article-level monotonicity: an article with no Storage
-- provenance today has never had any, and no candidate was ever staged on it,
-- so nothing derived was ever written into it.
update public.member_kb_articles article
set content_origin = 'authored'
where article.content_origin is null
  and article.knowledge_source_id is null
  and article.import_key is null
  and not exists (
    select 1
    from public.member_kb_article_revisions revision
    where revision.article_id = article.id
      and revision.knowledge_source_id is not null
  );

-- Everything left carries a Storage source, and nothing in this schema records
-- whether the text it holds today came out of THAT file. It is neither authored
-- nor attributable, so it is withheld — the source value stays on the row as
-- history, and stops gating anything.
update public.member_kb_articles article
set content_origin = 'unresolved'
where article.content_origin is null;

alter table public.member_kb_articles
  alter column content_origin set not null,
  add constraint member_kb_articles_content_origin_known
    check (content_origin in ('authored', 'derived', 'unresolved')),
  add constraint member_kb_articles_derived_names_its_source
    check (content_origin <> 'derived' or knowledge_source_id is not null),
  add constraint member_kb_articles_authored_has_no_source
    check (content_origin <> 'authored' or knowledge_source_id is null);

comment on column public.member_kb_articles.content_origin is
  'Explicit content-origin discriminator for the LIVE article row, mirroring public.member_kb_article_revisions.content_origin: authored (staff-typed or a literal string shipped in a migration, null knowledge_source_id), derived (lifted from an inspected Storage object, knowledge_source_id names the exact source the TEXT came from and gates every read of it), or unresolved (a historical row whose true origin cannot be proved; it keeps the knowledge_source_id it carries as history, that value gates nothing, and the row is never listed, returned, edited, published or retired). A withheld row is re-established only by a reviewed reconciliation from an inspected source.';

-- Every member and staff read now filters one chapter by this column, so give
-- the filter an index rather than leaving it to re-read the whole chapter.
create index if not exists member_kb_articles_chapter_origin_idx
  on public.member_kb_articles (chapter_id, content_origin);

-- --------------------------------------------------------------------------
-- 2. The two predicates, written once.
--
-- The first is the withholding predicate every article-level gate is routed
-- through. The second is the ONLY door back out of withholding, so "a withheld
-- article resurfaces only through a reviewed reconciliation from an inspected
-- source" is a property of one small function rather than of a condition
-- repeated in three bodies.
-- --------------------------------------------------------------------------
create function private.knowledge_article_content_current(
  p_article public.member_kb_articles
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  -- Fail closed on a row that is not there: a %rowtype variable left unset by a
  -- `select ... into` that found nothing has a null id, and answering true for
  -- it would make every `if not <predicate>` guard fail open.
  select case
    when p_article.id is null then false
    when p_article.content_origin is null then false
    when p_article.content_origin = 'unresolved' then false
    -- 'authored' carries a null source by constraint, and the wrapper answers
    -- true for a null source by design (invariant 6), so authored content and
    -- non-Storage sources keep their semantics through this one branch.
    else private.knowledge_source_verdict_current(p_article.knowledge_source_id)
  end;
$function$;

revoke all on function private.knowledge_article_content_current(public.member_kb_articles)
  from public, anon, authenticated, service_role;
grant execute on function private.knowledge_article_content_current(public.member_kb_articles)
  to authenticated, service_role;

comment on function private.knowledge_article_content_current(public.member_kb_articles) is
  'The one article-level withholding predicate: true for an authored article and for a derived article whose OWN originating Storage source holds a current ledger verdict; false for an unresolved (withheld) article, for a derived article whose source has lapsed, and for a row that is not there. private.knowledge_source_verdict_current is reached only through it, so no article-level gate can consult a source the record has withdrawn.';

create function private.knowledge_article_reestablishment_candidate(
  p_article public.member_kb_articles
)
returns public.member_kb_article_revisions
language sql
stable
security definer
set search_path = ''
as $function$
  -- Only a WITHHELD article has anything to re-establish, and only a candidate
  -- whose text is provably the INCOMING agreement's own may do it. Three
  -- conjuncts carry that, and none of them is an inference:
  --
  --   status = 'draft'  — the CHANGED-CLAUSE shape. 20260906029000 records why
  --     this is the provable one: the changed-clause branch is the only writer
  --     of a version-zero 'draft' row, and every text value it inserts
  --     (clean_title, clean_ref, clean_body, clean_keywords) comes out of the
  --     payload normalized from p_source_id's own inspected bytes rather than
  --     off the article. The RETIREMENT shape ('retired') is excluded exactly
  --     because it does the opposite: it COPIES the article's own text, which
  --     on a withheld article is the withheld text itself, so admitting one
  --     would hand back through the door what the door exists to withhold.
  --   content_origin = 'derived'  — the row names the exact source its bytes
  --     came from (member_kb_article_revisions_candidate_origin_known), so a
  --     legacy candidate the 20260906029000 backfill withheld cannot qualify.
  --   a current verdict on THAT source — the file has actually been inspected.
  --
  -- There is at most one version-zero row per article
  -- (member_kb_article_revisions_article_id_version_key), so the limit states
  -- that fact rather than choosing between rows.
  select candidate.*
  from public.member_kb_article_revisions candidate
  where p_article.id is not null
    and p_article.content_origin = 'unresolved'
    and candidate.article_id = p_article.id
    and candidate.version = 0
    and candidate.import_candidate_key is not null
    and candidate.status = 'draft'
    and candidate.content_origin = 'derived'
    and private.knowledge_source_verdict_current(candidate.knowledge_source_id)
  limit 1;
$function$;

revoke all on function private.knowledge_article_reestablishment_candidate(public.member_kb_articles)
  from public, anon, authenticated, service_role;
grant execute on function private.knowledge_article_reestablishment_candidate(public.member_kb_articles)
  to authenticated, service_role;

comment on function private.knowledge_article_reestablishment_candidate(public.member_kb_articles) is
  'The ONE door out of article-level withholding: for an unresolved article it returns the version-zero CHANGED-CLAUSE candidate (status draft) whose own content_origin is derived and whose own Storage source holds a current ledger verdict — the one candidate shape whose text is provably the incoming agreement''s own inspected bytes rather than a copy of the article — and for every other article, and for a retirement-shaped candidate, it returns nothing. list_chapter_kb_revisions and list_knowledge_review_articles_snapshot admit a withheld article only when it opens, and restore_chapter_kb_revision accepts only the exact revision it names; the candidate''s text belongs to the incoming source, so nothing withheld crosses the boundary.';

-- --------------------------------------------------------------------------
-- 3. The member-facing corpus, the table itself and Compass retrieval.
--
-- These three are the surfaces that actually carry a clause's TEXT to a
-- member, and none of them requires a staff role. Each one had exactly one
-- provenance conjunct and it read the article's own knowledge_source_id; each
-- one now reads the predicate above instead, so a withheld row is omitted for
-- the same reason a lapsed one is, through one expression rather than two.
-- --------------------------------------------------------------------------
create or replace function public.list_accessible_knowledge_articles_snapshot(
  p_published_only boolean default false,
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
  home_chapter text := private.current_member_chapter();
  requested_chapter text := nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), '');
  target_chapter text;
  published_only boolean := coalesce(p_published_only, false);
begin
  if published_only then
    if requested_chapter is not null
       and requested_chapter is distinct from home_chapter then
      raise exception 'not authorized' using errcode = '42501';
    end if;
    target_chapter := home_chapter;
  else
    target_chapter := coalesce(requested_chapter, home_chapter);
    if target_chapter is not null
       and not (
         private.mi1_knowledge_collection_staff(org)
         or (
           target_chapter is not distinct from home_chapter
           and public.member_has_role(array['steward','coordinator','advisor','admin','vp'])
         )
       ) then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  end if;

  if target_chapter is null then
    return '[]'::jsonb;
  end if;
  if not private.mi1_w2_same_org_chapter(org, target_chapter) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', article.id,
        'slug', article.slug,
        'chapter_id', article.chapter_id,
        'kind', article.kind,
        'title', article.title,
        'article_ref', article.article_ref,
        'body', article.body,
        'keywords', article.keywords,
        'order_index', article.order_index,
        'status', article.status,
        'is_sample', article.is_sample,
        'version', article.version,
        'created_by', article.created_by,
        'updated_by', article.updated_by,
        'verified_by', article.verified_by,
        'verified_at', article.verified_at,
        'created_at', article.created_at,
        'updated_at', article.updated_at
      ) order by article.order_index, article.id
    )
    from public.member_kb_articles article
    where article.chapter_id = target_chapter
      and not article.is_sample
      and private.knowledge_article_content_current(article)
      and (
        not published_only
        or (
          article.status = 'published'
          and article.verified_by is not null
          and article.verified_at is not null
        )
      )
  ), '[]'::jsonb);
end;
$function$;

-- `public.member_kb_articles` carries a direct `select` grant to
-- `authenticated`, and both clients read `body` straight through PostgREST, so
-- the same predicate has to sit on the two read policies or the SQL gates are
-- walkable by the ordinary query the apps already issue. The predicate is a
-- whole-row one, so the policy states it once rather than restating a column
-- list that a later column could fall out of.
drop policy if exists member_kb_articles_member_read on public.member_kb_articles;
create policy member_kb_articles_member_read
  on public.member_kb_articles for select to authenticated
  using (
    chapter_id = private.current_member_chapter()
    and not is_sample
    and status = 'published'
    and verified_by is not null
    and verified_at is not null
    and private.knowledge_article_content_current(member_kb_articles)
  );

drop policy if exists member_kb_articles_staff_read on public.member_kb_articles;
create policy member_kb_articles_staff_read
  on public.member_kb_articles for select to authenticated
  using (
    chapter_id = private.current_member_chapter()
    and not is_sample
    and public.member_has_role(array['steward','coordinator','advisor','admin','vp'])
    and private.knowledge_article_content_current(member_kb_articles)
  );

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
      and private.knowledge_article_content_current(a)
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

-- --------------------------------------------------------------------------
-- 4. Collection projection and placement.
--
-- Metadata only, and the same class of surface as the review snapshot. A
-- withheld article is dropped from the projection and cannot be ADDED to a
-- collection; REMOVAL deliberately stays open, exactly as it does for a lapsed
-- verdict, so withholding cannot strand a placement row nobody can see.
-- --------------------------------------------------------------------------
create or replace function public.list_knowledge_collections(p_chapter_id text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  requested_chapter text := nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), '');
  org uuid := private.mi1_knowledge_context_organization(requested_chapter);
  home_chapter text := private.current_member_chapter();
  chapter text := coalesce(requested_chapter, home_chapter);
  staff boolean := private.mi1_knowledge_collection_staff(org);
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if requested_chapter is not null
     and (not staff or not private.mi1_w2_same_org_chapter(org, requested_chapter)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if requested_chapter is null
     and chapter is not null
     and not private.mi1_w2_same_org_chapter(org, chapter) then
    chapter := null;
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', collection.id,
      'title', collection.title,
      'description', collection.description,
      'visibility', collection.visibility,
      'chapterId', collection.chapter_id,
      'sortOrder', collection.sort_order,
      'items', coalesce((
        select pg_catalog.jsonb_agg(item.value order by item.sort_order, item.id)
        from (
          select placement.id, placement.sort_order, pg_catalog.jsonb_build_object(
            'id', placement.id,
            'kind', 'kb_article',
            'itemId', article.id,
            'title', article.title,
            'summary', article.article_ref,
            'status', article.status,
            'version', article.version
          ) as value
          from public.knowledge_collection_items placement
          join public.member_kb_articles article on article.id = placement.kb_article_id
          where placement.collection_id = collection.id
            and article.chapter_id = chapter
            and not article.is_sample
            and private.knowledge_article_content_current(article)
            and (staff or (
              article.status = 'published'
              and article.verified_by is not null
              and article.verified_at is not null
            ))
          union all
          select placement.id, placement.sort_order, pg_catalog.jsonb_build_object(
            'id', placement.id,
            'kind', 'knowledge_file',
            'itemId', file.id,
            'title', file.title,
            'summary', file.summary,
            'status', file.review_status,
            'version', 1
          ) as value
          from public.knowledge_collection_items placement
          join public.organization_knowledge_files file on file.id = placement.knowledge_file_id
          where placement.collection_id = collection.id
            and file.organization_id = org
            and (file.storage_kind <> 'organization_storage'
              or private.private_upload_is_current('organization-knowledge', file.storage_path))
            and (staff or (
              file.published_to_catalog
              and file.review_status = 'approved'
            ))
        ) item
      ), '[]'::jsonb)
    ) order by collection.sort_order, collection.title, collection.id)
    from public.knowledge_collections collection
    where collection.organization_id = org
      and (collection.chapter_id is null or collection.chapter_id = chapter)
      and (collection.visibility = 'organization' or staff)
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.set_knowledge_collection_item(
  p_collection_id uuid,
  p_item_kind text,
  p_item_id uuid,
  p_include boolean,
  p_sort_order integer,
  p_chapter_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  requested_chapter text := nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), '');
  org uuid := private.mi1_knowledge_context_organization(requested_chapter);
  home_chapter text := private.current_member_chapter();
  chapter text := coalesce(requested_chapter, home_chapter);
  actor uuid := (select auth.uid());
  collection public.knowledge_collections%rowtype;
begin
  if not private.mfa_satisfied() or not private.mi1_knowledge_collection_staff(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if requested_chapter is not null
     and not private.mi1_w2_same_org_chapter(org, requested_chapter) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if requested_chapter is null
     and chapter is not null
     and not private.mi1_w2_same_org_chapter(org, chapter) then
    chapter := null;
  end if;
  if p_item_kind not in ('kb_article', 'knowledge_file')
     or p_item_id is null
     or coalesce(p_sort_order, 500) not between 0 and 100000 then
    raise exception 'invalid collection item' using errcode = '22023';
  end if;

  select * into collection
  from public.knowledge_collections source
  where source.id = p_collection_id
    and source.organization_id = org
  for update;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if collection.chapter_id is not null
     and collection.chapter_id is distinct from chapter then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if collection.chapter_id is null
     and not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- Adding a Storage-derived article to a collection needs a live verdict for
  -- the file it came from; removing one never does, so a lapse cannot strand a
  -- placement row that staff can no longer see.
  if p_item_kind = 'kb_article' and not exists (
    select 1
    from public.member_kb_articles article
    where article.id = p_item_id
      and article.chapter_id = chapter
      and not article.is_sample
      and (
        not coalesce(p_include, false)
        or private.knowledge_article_content_current(article)
      )
  ) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if p_item_kind = 'knowledge_file' and not exists (
    select 1
    from public.organization_knowledge_files file
    where file.id = p_item_id
      and file.organization_id = org
  ) then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if coalesce(p_include, false) then
    insert into public.knowledge_collection_items (
      organization_id, collection_id, item_kind, kb_article_id,
      knowledge_file_id, sort_order, added_by
    ) values (
      org,
      collection.id,
      p_item_kind,
      case when p_item_kind = 'kb_article' then p_item_id else null end,
      case when p_item_kind = 'knowledge_file' then p_item_id else null end,
      coalesce(p_sort_order, 500),
      actor
    ) on conflict do nothing;
  else
    delete from public.knowledge_collection_items item
    where item.collection_id = collection.id
      and (
        (p_item_kind = 'kb_article' and item.kb_article_id = p_item_id)
        or (p_item_kind = 'knowledge_file' and item.knowledge_file_id = p_item_id)
      );
  end if;

  perform private.mi1_w2_write_audit(org, 'knowledge_collection_item_changed', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'chapterId', chapter,
    'collectionId', collection.id,
    'itemKind', p_item_kind,
    'itemId', p_item_id,
    'included', coalesce(p_include, false)
  ));
  return public.list_knowledge_collections(chapter);
end;
$function$;

-- --------------------------------------------------------------------------
-- 5. The staff review surfaces, and the one door.
--
-- These two are where a withheld article can still be acted on, and only in
-- one way: the reviewed re-establishment. A withheld article is otherwise
-- absent from both, with the refusal each already uses for an article that is
-- not there. When the door IS open, the review listing reports THE CANDIDATE's
-- naming rather than the withheld article's, and the revision listing's
-- per-revision filter shows that candidate and nothing else, because every row
-- of the article's own history is 'unresolved'.
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
      -- A withheld article contributes NO text of its own. When it is listed
      -- at all it is listed under the incoming candidate's naming, which is
      -- the replacement agreement's own inspected text and is gated on that
      -- agreement's own current verdict.
      'title', case when candidate.id is null then article.title else candidate.title end,
      'articleRef', case when candidate.id is null then article.article_ref else candidate.article_ref end,
      'contentWithheld', candidate.id is not null,
      'status', article.status,
      'version', article.version,
      'orderIndex', article.order_index
    ) order by article.order_index, article.id)
    from public.member_kb_articles article
    left join lateral private.knowledge_article_reestablishment_candidate(article) candidate
      on true
    where article.chapter_id = target_chapter
      and not article.is_sample
      and (
        private.knowledge_article_content_current(article)
        or candidate.id is not null
      )
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
  -- The article-level precondition is the withholding predicate, plus the one
  -- re-establishment door. A withheld article answers with the same P0002 an
  -- article that is not there answers with; when a later reconciliation has
  -- staged a candidate from its OWN inspected bytes the article is admitted so
  -- that candidate can be reviewed, and the per-revision filter below then
  -- shows that candidate and nothing else, because every withheld row of the
  -- article's own history is 'unresolved'.
  if not exists (
    select 1 from public.member_kb_articles article
    left join lateral private.knowledge_article_reestablishment_candidate(article) candidate
      on true
    where article.id = p_article_id and article.chapter_id = chapter and not article.is_sample
      and (
        private.knowledge_article_content_current(article)
        or candidate.id is not null
      )
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
-- 6. Restore, and the receipt reconstructor that replays it.
--
-- restore_chapter_kb_revision is both the refusal surface for a withheld
-- article and the one writer that can lift the withholding, so the two live
-- side by side here. It writes the article's origin from the revision it
-- restored — never 'unresolved', because an unresolved revision was already
-- refused — which is why re-establishment needs no separate write path.
-- --------------------------------------------------------------------------
create or replace function private.knowledge_revision_restore_receipt(
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
  -- Both halves of the withholding predicate, each keeping the refusal shape
  -- the primary path already uses: a withheld article is absent (P0002), a
  -- lapsed verdict is 42501 'file inspection required'.
  if not private.knowledge_article_content_current(article) then
    if article.content_origin = 'unresolved' then
      raise exception 'not found' using errcode = 'P0002';
    end if;
    raise exception 'file inspection required' using errcode = '42501';
  end if;
  return pg_catalog.to_jsonb(article);
end;
$function$;

revoke all on function private.knowledge_revision_restore_receipt(text, jsonb)
  from public, anon, authenticated, service_role;

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
  restored_origin text;
  reestablishing boolean := false;
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
  -- THE ARTICLE-LEVEL WITHHOLDING, AND ITS ONE DOOR (20260906030000).
  -- A withheld article answers with the same P0002 an article that is not
  -- there answers with, so this RPC is not an oracle for withheld text. The
  -- single exception is the reviewed re-establishment: the version-zero
  -- candidate a later reconciliation staged out of its OWN inspected bytes.
  -- That candidate's text belongs to the incoming source, not to the withheld
  -- article, so admitting it discloses nothing that was withdrawn — and it is
  -- the only way a withheld article ever becomes readable again.
  --
  -- The other half of the predicate keeps the shape this record already
  -- established: an article whose own source has lapsed is refused 42501
  -- 'file inspection required', exactly as before.
  if not private.knowledge_article_content_current(article) then
    if article.content_origin = 'unresolved' then
      if revision.id is distinct from
         (private.knowledge_article_reestablishment_candidate(article)).id then
        raise exception 'not found' using errcode = 'P0002';
      end if;
      reestablishing := true;
    else
      raise exception 'file inspection required' using errcode = '42501';
    end if;
  end if;
  -- Publication of storage-derived language needs a live verdict for the file
  -- the language came from. The candidate revision's OWN source is checked
  -- here, always: on the ordinary path the article's own source was checked by
  -- the predicate above, and on the re-establishment path the article's own
  -- source is precisely the claim this record has withdrawn, so it gates
  -- nothing. Authored revisions carry a null source, and authored articles and
  -- non-Storage sources (external_url, inline text, Drive) answer true and keep
  -- their semantics unchanged.
  if not private.knowledge_source_verdict_current(revision.knowledge_source_id) then
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
  -- The article's origin is taken from the revision being restored, never from
  -- what the article carried before. It is therefore 'authored' or 'derived'
  -- and NEVER 'unresolved': an unresolved revision was already refused above,
  -- so nothing this function writes can create a withheld row — it can only
  -- resolve one, which is what the re-establishment path is.
  restored_origin := case when restored_source is null then 'authored' else 'derived' end;
  -- Under the writer rules 20260906028000 establishes, a derived article only
  -- ever holds derived revisions and an authored article only ever holds
  -- authored ones, so this cannot fire on the ordinary path. It is written as a
  -- refusal rather than a silent adjustment because the alternative is
  -- rewriting import_key to keep member_kb_articles_import_provenance_complete
  -- satisfied, which would detach a clause from the lineage a later
  -- reconciliation reconciles against.
  --
  -- The re-establishment path is deliberately exempt, because it IS a change of
  -- origin: from the withdrawn 'unresolved' to the candidate's own 'derived'.
  -- Its shapes agree anyway — a withheld article that a reconciliation could
  -- reach carries a non-null knowledge_source_id and import_key by construction,
  -- and the candidate is derived — so the exemption changes no outcome; it is
  -- written out so the intent is not re-derived later as a defect.
  if not reestablishing
     and (restored_source is null) is distinct from (article.knowledge_source_id is null) then
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
      content_origin = restored_origin,
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
    restored.content_origin,
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
-- 7. The two remaining publication routes.
--
-- save and retire never move an article's origin: they rewrite or retire the
-- text of the article they were given, so the article keeps the origin it had
-- and the appended revision takes it from the row rather than re-deriving it
-- from the source column. Neither will touch a withheld article at all.
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
      verified_by, verified_at, updated_at, content_origin
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
      pg_catalog.now(),
      -- Stated, never defaulted. A new article typed by staff has no Storage
      -- provenance and cannot acquire one here: the column list above does not
      -- mention knowledge_source_id, and 'authored' requires it to be null.
      'authored'
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

    -- The second publication route to a Storage-derived row, now gated on the
    -- whole withholding predicate. Its two halves keep the two refusal shapes
    -- this record already established, and neither is an oracle:
    --   * A WITHHELD article answers exactly as an absent one does. Its text
    --     cannot be proved to have come from the source it names, so it may
    --     not be edited, re-published or re-verified, and saying so distinctly
    --     would report the existence of content that is being withheld.
    --   * A lapsed verdict keeps 42501 'file inspection required', for exactly
    --     the reason restore_chapter_kb_revision refuses it, with the same
    --     SQLSTATE and the same message.
    -- Authored articles carry a null knowledge_source_id and stay editable.
    if not private.knowledge_article_content_current(saved) then
      if saved.content_origin = 'unresolved' then
        raise exception 'knowledge article is not available in this chapter' using errcode = '42501';
      end if;
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
    saved.content_origin,
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

  -- A WITHHELD ARTICLE IS ABSENT TO THIS PATH TOO, with the same 42501 and the
  -- same message an article that is not in this chapter gets. Retirement is a
  -- publication-state change on a row whose text cannot be attributed, and the
  -- appended revision would have to name an origin this record has withdrawn;
  -- the honest answer is that there is nothing here to retire. A withheld
  -- article is already absent from every member and staff read, so nothing is
  -- stranded in front of anyone, and the next reconciliation of that chapter
  -- re-establishes or re-stages it (see 20260906030000's header).
  if saved.content_origin = 'unresolved' then
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
  -- The whole withholding predicate, whose withheld half was answered above, so
  -- what reaches here is exactly the lapsed-verdict half this path already had.
  derived_lapsed := not private.knowledge_article_content_current(saved);

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
    saved.content_origin,
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

-- --------------------------------------------------------------------------
-- 8. CBA reconciliation: it states the origin it creates, and it is the only
--    thing that can re-establish a withheld one.
--
-- Every article this function writes gets an explicit 'derived' with the source
-- in the same statement, and every canonical revision it appends takes the
-- article's stated origin rather than re-deriving it from the source column.
-- The three withheld-article rules are marked RE-ESTABLISHMENT below: a
-- withheld published clause is always treated as changed, a withheld draft is
-- never skipped as an identical retry, and a withheld article stages no
-- retirement candidate and is not swept into 'retired'.
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
        -- RE-ESTABLISHMENT. A WITHHELD article is treated as changed even when
        -- the incoming clause is byte-identical to what the row holds. The
        -- point of the candidate is not that the text differs; it is that the
        -- staged row carries THIS agreement's own inspected bytes and names
        -- THIS agreement, so a reviewer's restore re-sources the article from
        -- a file that has actually been inspected. Comparing text and skipping
        -- would leave the article withheld forever behind an equality that
        -- proves nothing about where its bytes came from.
        if current_article.content_origin = 'unresolved'
           or current_article.title is distinct from clean_title
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
      -- The same rule on the draft branch: an identical-text retry of a
      -- WITHHELD draft is not "nothing to do", it is the re-establishment, so
      -- it falls through to the update below and takes this source explicitly.
      if current_article.status = 'draft'
         and current_article.content_origin <> 'unresolved'
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
      -- The body written here IS p_source_id's own normalized text, so the
      -- origin is stated with the source in the same statement. This is also
      -- the second re-establishment route: a withheld DRAFT reached here
      -- leaves it resolved on the agreement whose bytes it now holds.
      update public.member_kb_articles
      set title = clean_title, article_ref = clean_ref, body = clean_body,
          keywords = clean_keywords, order_index = base_order + item.ordinality,
          status = 'draft', version = version + 1,
          knowledge_source_id = p_source_id,
          content_origin = 'derived',
          updated_by = p_actor_user_id, verified_by = null, verified_at = null,
          updated_at = pg_catalog.now()
      where id = target_article_id;
    else
      target_article_id := extensions.gen_random_uuid();
      insert into public.member_kb_articles (
        id, slug, kind, title, article_ref, body, keywords, order_index,
        chapter_id, status, is_sample, version, created_by, updated_by,
        verified_by, verified_at, updated_at, knowledge_source_id, import_key,
        content_origin
      ) values (
        target_article_id,
        'cba-' || pg_catalog.replace(p_source_id::text, '-', '') || '-' || pg_catalog.substr(item_key, 1, 16),
        'contract', clean_title, clean_ref, clean_body, clean_keywords,
        base_order + item.ordinality, p_chapter_id, 'draft', false, 1,
        p_actor_user_id, p_actor_user_id, null, null, pg_catalog.now(),
        p_source_id, item_key,
        'derived'
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
      article.content_origin,
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
      -- A withheld draft is skipped rather than retired. The revision this
      -- statement appends would have to state an origin, and the only honest
      -- one is the withdrawn claim: 'derived' would re-assert it and
      -- 'unresolved' is forbidden a non-null source by
      -- member_kb_article_revisions_unresolved_names_no_source. The row is
      -- already invisible everywhere, so nothing is served by moving it.
      and article.content_origin <> 'unresolved'
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
    article.content_origin,
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
      -- A withheld article stages NO retirement candidate. The candidate is a
      -- copy of the article's own text stamped with the article's own source,
      -- and on a withheld row that source is exactly the claim this record has
      -- withdrawn — staging it would re-launder the very fact 20260906030000
      -- withheld. There is also nothing for a reviewer to decide: the row is
      -- already absent from every member and staff read.
      and article.content_origin <> 'unresolved'
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
-- 9. The SAMPLE seed states the article's origin as explicitly as it already
--    states its revisions'.
--
-- It writes literal strings that live in a shipped migration file, never
-- Storage bytes, and it never sets knowledge_source_id — so its articles are
-- authored. It is re-emitted rather than given a column default, for the same
-- reason 20260906028000 re-emitted it: a default is exactly the mechanism that
-- would let a future writer classify derived text as authored by omission.
-- --------------------------------------------------------------------------
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
      verified_by, verified_at, updated_at, content_origin
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
      pg_catalog.now() - interval '1 day', pg_catalog.now() - interval '1 day',
      'authored'
    ) on conflict (id) do update set
      content_origin = excluded.content_origin,
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
-- 10. Grants and contract comments.
--
-- `create or replace` preserves the ACL; every grant this migration touches is
-- re-stated so the surface is readable in one file.
-- --------------------------------------------------------------------------
revoke all on function public.list_accessible_knowledge_articles_snapshot(boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_accessible_knowledge_articles_snapshot(boolean, text)
  to authenticated;
revoke all on function public.search_member_kb(text, integer) from public, anon;
grant execute on function public.search_member_kb(text, integer) to authenticated;
revoke all on function public.list_knowledge_collections(text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_knowledge_collections(text)
  to authenticated;
revoke all on function public.set_knowledge_collection_item(
  uuid, text, uuid, boolean, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.set_knowledge_collection_item(
  uuid, text, uuid, boolean, integer, text
) to authenticated;
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
revoke all on function public.replace_cba_knowledge_drafts(uuid, uuid, uuid, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.replace_cba_knowledge_drafts(uuid, uuid, uuid, text, jsonb)
  to service_role;
revoke all on function private.demo_seed_apply_knowledge_library(text, uuid)
  from public, anon, authenticated, service_role;

comment on function public.list_accessible_knowledge_articles_snapshot(boolean, text) is
  'Returns one statement-consistent chapter corpus. Member reads stay on the current chapter and verified publication boundary; staff may explicitly select only a chapter in their active organization; an article whose content this record cannot stand behind is excluded from both — a withheld (unresolved) article, and a derived article whose originating Storage source no longer holds a current ledger verdict.';
comment on function public.list_knowledge_collections(text) is
  'Tenant-scoped collection projection follows one current or explicitly selected same-organization chapter; members stay on their home chapter and published, verified material; a placed article that is withheld or whose originating Storage object has lost its current ledger verdict is omitted, as is a placed file whose object has.';
comment on function public.set_knowledge_collection_item(
  uuid, text, uuid, boolean, integer, text
) is
  'Staff-only collection placement writer carries one validated selected chapter and restricts organization-scope placements to advisor, admin, and VP roles; a withheld article, and one whose originating Storage source has lost its current ledger verdict, cannot be added, while removal stays reachable.';
comment on function public.list_knowledge_review_articles_snapshot(text) is
  'Returns every reviewable article for one explicitly selected same-organization chapter from one statement snapshot, so CBA reconciliation cannot move a cursor between pages. A withheld article and one whose originating Storage source has lapsed are excluded; the single exception is a withheld article carrying a reviewed re-establishment candidate, which is listed under THE CANDIDATE''s title and articleRef — the incoming agreement''s own inspected text — with contentWithheld true, so the pending decision is reachable without the withheld naming crossing the boundary.';
comment on function public.list_chapter_kb_revisions(uuid, text) is
  'Staff-only bounded revision history follows an explicit same-organization review chapter, with the current chapter retained as the legacy default. Each revision is gated on ITS OWN content source, unresolved-origin history is never listed, and contentOrigin plus reconciledBySourceId are projected. The article-level precondition is the withholding predicate: a withheld article answers with the same P0002 an absent one does, except when it carries a reviewed re-establishment candidate, in which case that candidate — and nothing else, since the rest of its history is unresolved — is listed.';
comment on function public.restore_chapter_kb_revision(uuid, bigint, boolean, uuid, text) is
  'Idempotent explicit-chapter staff review can draft or verify imported changes, confirm retirement, or dismiss a proposed removal without changing canonical content. It refuses an unresolved-origin revision and a withheld article with the same P0002 an absent row answers with, refuses 42501 whenever a derived article''s or the candidate revision''s own originating Storage source has lost its current ledger verdict, sets the restored article''s provenance AND content origin from the revision''s own content origin instead of coalescing onto an unrelated current source, stores only content-free lifecycle metadata in its idempotency receipt, and reconstructs any replay through a current gated read bound to the original actor. It is also the one writer that lifts article-level withholding, and only for the reviewed re-establishment candidate a later reconciliation staged from its own inspected bytes.';
comment on function public.save_chapter_kb_article(
  uuid, text, text, text, text, text[], text, boolean, text
) is
  'MFA-aware staff-only create/edit/publish path accepts only the current chapter or an explicitly selected same-organization chapter; a new article states content_origin = ''authored'' explicitly and every successful save appends an immutable revision carrying the article''s own stated origin, so a staff edit of Storage-derived language stays derived. A withheld article answers exactly as an absent one does; a derived article whose originating Storage source has lost its current ledger verdict is refused 42501 ''file inspection required''.';
comment on function public.retire_chapter_kb_article(uuid, text) is
  'Soft-retires a Compass source in the caller current chapter or an explicitly selected same-organization chapter authorized to organization staff; retirement stays reachable when the originating Storage source has lost its current ledger verdict, but the returned row then carries no title, article_ref, body or keywords. A withheld article answers exactly as an absent one does, because the revision this path appends would have to state an origin the record has withdrawn. The appended revision carries the article''s own stated origin.';
comment on function public.replace_cba_knowledge_drafts(uuid, uuid, uuid, text, jsonb) is
  'Service-only, chapter-serialized CBA reconciliation re-establishes the originating object''s ledger verdict under its Storage row lock, then derives stable clause keys, preserves a collision-free contiguous agreement order range without versioning identical draft retries, keeps published and independently authored articles, clears stale candidates, and stages changed or missing verified clauses for explicit review. Every article and revision it writes states its content origin explicitly, and CONTENT provenance stays separate from DECISION provenance. It is also the only path that re-establishes a WITHHELD article: such an article is treated as changed even when the incoming clause is byte-identical, so the staged candidate carries this agreement''s own inspected bytes and a reviewer''s restore re-sources the row; a withheld article stages no retirement candidate and is not swept into retired, because both would re-assert the provenance claim this record withdrew.';
comment on function private.demo_seed_apply_knowledge_library(text, uuid) is
  'Private deterministic SAMPLE seed for CR-071 through CR-075; it creates no organization, user, provider credential, or delivery. Its knowledge articles and revisions are literal strings shipped in a migration file with no Storage provenance, so both are recorded as authored explicitly rather than by a column default.';

notify pgrst, 'reload schema';
commit;
