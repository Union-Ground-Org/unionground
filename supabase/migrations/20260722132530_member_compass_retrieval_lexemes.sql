-- Compass retrieval, refinement: build the OR query from the query's lexemes
-- directly (tsvector_to_array) instead of string-rewriting the websearch
-- operator tree. This is robust against negation ("-telework"), quoted phrases,
-- and any operator — it simply ORs every content lexeme for recall-oriented
-- retrieval, with ts_rank ordering by relevance. Also fully pg_catalog-qualified.
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
