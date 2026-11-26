-- UB-RGT-02: Chapter library documents are invisible to Compass.
--
-- search_member_kb backed Compass retrieval with three sources — the member KB
-- articles, the rights lessons, and the member's own cases. chapter_documents,
-- the library that staff actually publish contracts, policies and POMs into,
-- was not one of them. Every document a coordinator uploaded was unreachable to
-- the assistant the members ask, so Compass answered "the SOURCES do not cover
-- this" about text sitting in the same database.
--
-- This adds the fourth branch. Three things about it are deliberate:
--
--   * `status = 'published'` is filtered HERE, not left to RLS. The read policy
--     deliberately lets staff see their own drafts (20260808040000) so the
--     Library can show them, but a draft is not something Compass may cite back
--     to anyone as chapter policy — a half-written telework rule quoted as
--     settled is worse than no answer. Published-only is the acceptance
--     criterion's own wording and it holds for staff askers too.
--   * The function stays `security invoker`, so the chapter scope and the
--     chapter/staff visibility split come from chapter_documents_read as
--     written. Retrieval adds no new read path: a member can only be cited
--     documents they could already open in the Library.
--   * The snippet prefers `summary` over `body`. Summaries are authored to be
--     the 1,000-character precis; body runs to 100,000 and its first 320
--     characters are usually a title block. Falling back to body keeps
--     documents that were saved without a summary retrievable.
--
-- Ordering constant 1500 slots the library between the rights lessons (1000+)
-- and the member's own cases (2000), which only matters for exact ts_rank ties.
--
-- Do NOT add a GIN expression index to this invoker query. `@@` is not
-- leakproof, so PostgreSQL cannot push the search term through the RLS security
-- barrier and use it as a GIN Index Cond for authenticated callers. A previous
-- draft added exactly that index; authenticated EXPLAIN proved it merely
-- enumerated published entries and still evaluated to_tsvector as a filter.
-- The existing chapter_documents_chapter_status_idx performs the safe,
-- selective part first (caller's chapter + published status); full-text
-- matching then runs only over rows RLS has admitted. If library scale later
-- requires GIN, it needs a separately reviewed, explicitly scoped definer
-- retrieval boundary rather than a decorative index on this invoker query.

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
      a.kind as kind,
      a.title as title,
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
    where (select ts from q) is null
       or pg_catalog.to_tsvector(
            'english',
            coalesce(a.title, '') || ' ' || coalesce(a.article_ref, '') || ' ' ||
            coalesce(a.body, '') || ' ' || pg_catalog.array_to_string(a.keywords, ' ')
          ) @@ (select ts from q)

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
      pg_catalog.left(
        coalesce(nullif(pg_catalog.btrim(d.summary), ''), d.body),
        320
      ),
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
      and d.status = 'published'
      and pg_catalog.to_tsvector(
            'english',
            coalesce(d.title, '') || ' ' || coalesce(d.document_type, '') || ' ' ||
            coalesce(d.summary, '') || ' ' || coalesce(d.body, '')
          ) @@ (select ts from q)

    union all

    select
      'case:' || c.id::text,
      'case',
      c.title,
      'Your case · ' || c.reference,
      pg_catalog.left(nullif(pg_catalog.btrim(c.articles), ''), 320),
      pg_catalog.ts_rank(
        pg_catalog.to_tsvector(
          'english',
          coalesce(c.title, '') || ' ' || coalesce(c.reference, '') || ' ' ||
          coalesce(c.articles, '') || ' ' || coalesce(c.case_type, '')
        ),
        (select ts from q)
      ),
      2000
    from public.member_cases c
    where (select ts from q) is not null
      and pg_catalog.to_tsvector(
            'english',
            coalesce(c.title, '') || ' ' || coalesce(c.reference, '') || ' ' ||
            coalesce(c.articles, '') || ' ' || coalesce(c.case_type, '')
          ) @@ (select ts from q)
  )
  select source_id, kind, title, ref, snippet
  from scored
  order by score desc, ord asc
  limit (select lim from q);
$$;
