-- REQ-UG-COMPASS-HYBRID-RETRIEVAL-PGVECTOR-20260929
-- Semantic recall beside Compass's lexical search.
--
-- * pgvector in the extensions schema (Supabase ships it; nothing else in this
--   repository used it before).
-- * public.member_kb_article_embeddings: one row per (article, chunk) with the
--   embedding, the embedding model and its digest, and the sha256 of the
--   article body the chunk was cut from. The FK cascades deletion with its
--   source, including organization/account lifecycle paths; graph gates and
--   reviewed trigger hashes participate in the repository lock protocol.
-- * RLS mirrors member_kb_articles' member read gate through the article row
--   itself, plus the repository-wide mfa_assurance restrictive policy. Writes
--   come only from the service role (scripts/backfill-member-kb-embeddings.mjs).
-- * public.search_member_kb_hybrid(p_query, p_embedding, p_limit): the
--   existing lexical search (unchanged, still the fallback) fused by
--   reciprocal rank (k = 60) with a cosine top-k over the embeddings, under
--   exactly the same chapter, sample, status, verification and
--   knowledge_article_content_current gates. Security INVOKER like
--   search_member_kb; a null embedding degrades to the lexical ranking.
begin;

create extension if not exists vector with schema extensions;

create table public.member_kb_article_embeddings (
  article_id uuid not null references public.member_kb_articles(id) on update cascade on delete cascade,
  chunk_no integer not null,
  chunk text not null,
  embedding extensions.vector(1024) not null,
  model text not null,
  digest text not null,
  body_sha256 text not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint member_kb_article_embeddings_nonzero_check check (extensions.vector_norm(embedding) > 0),
  constraint member_kb_article_embeddings_pkey primary key (article_id, chunk_no),
  constraint member_kb_article_embeddings_chunk_no_check check (chunk_no >= 0 and chunk_no < 1000),
  constraint member_kb_article_embeddings_chunk_check check (pg_catalog.char_length(chunk) between 1 and 4000),
  constraint member_kb_article_embeddings_model_check check (model ~ '^[a-z0-9][a-z0-9._:/-]{0,119}$'),
  constraint member_kb_article_embeddings_digest_check check (digest ~ '^sha256:[0-9a-f]{64}$'),
  constraint member_kb_article_embeddings_body_sha256_check check (body_sha256 ~ '^[0-9a-f]{64}$')
);

comment on table public.member_kb_article_embeddings is
  'Semantic index beside member_kb_articles for Compass hybrid retrieval: one row per (article, chunk) with the embedding, the embedding model and digest, and the sha256 of the article body the chunk came from. The source FK cascades deletion under the reviewed case-graph gates. Stale or differently pinned vectors are hidden on direct reads and in search, and pruned by the backfill. Read through the same gates as member_kb_articles; written only by the service role.';

-- The source article participates in the account/case graph. The side table
-- has no direct Auth or case key; it still acquires the common gate first.
create trigger a00_case_graph_lock before insert or update or delete on public.member_kb_article_embeddings
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.member_kb_article_embeddings
for each row execute function private.lock_case_graph_row_keys('', '');

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'public' and table_name = 'member_kb_article_embeddings'
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys');

do $embedding_lifecycle_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'incomplete lifecycle trigger review after article embeddings';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive reference after article embeddings';
  end if;
end;
$embedding_lifecycle_review$;

create index member_kb_article_embeddings_embedding_hnsw_idx
  on public.member_kb_article_embeddings
  using hnsw (embedding extensions.vector_cosine_ops);

alter table public.member_kb_article_embeddings enable row level security;
alter table public.member_kb_article_embeddings force row level security;
revoke all on table public.member_kb_article_embeddings from public, anon, authenticated;
grant select on table public.member_kb_article_embeddings to authenticated;
grant select, insert, update, delete on table public.member_kb_article_embeddings to service_role;

create policy mfa_assurance on public.member_kb_article_embeddings
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.member_kb_article_embeddings is
  'Repository-wide restrictive MFA assurance, stated explicitly because the DO loop that installed it on older tables does not run for a table created later; the contract sweep requires it on every RLS table.';

-- The same predicate as member_kb_articles_member_read, evaluated on the
-- article the chunk belongs to. A chunk is visible exactly when its article is.
create policy member_kb_article_embeddings_member_read
  on public.member_kb_article_embeddings for select to authenticated
  using (
    model = 'bge-m3'
    and digest = 'sha256:7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab'
    and exists (
      select 1
      from public.member_kb_articles a
      where a.id = member_kb_article_embeddings.article_id
        and a.chapter_id = private.current_member_chapter()
        and not a.is_sample
        and a.status = 'published'
        and a.verified_by is not null
        and a.verified_at is not null
        and private.knowledge_article_content_current(a)
        and body_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(a.body, 'UTF8')), 'hex')
    )
  );
comment on policy member_kb_article_embeddings_member_read on public.member_kb_article_embeddings is
  'A chunk is readable only with its current body hash and pinned model/digest, and when its article is readable under member_kb_articles_member_read: same chapter, sample, status, verification and knowledge_article_content_current conjuncts, evaluated on the article row through EXISTS so the two gates cannot drift apart. No write policy: the service-role backfill is the only writer.';

create function public.search_member_kb_hybrid(
  p_query text,
  p_embedding extensions.vector(1024),
  p_limit integer default 4
)
returns table (source_id text, kind text, title text, ref text, snippet text)
language sql
stable
security invoker
set search_path = ''
as $$
  with lim as (
    select least(greatest(coalesce(p_limit, 4), 1), 6) as n
  ),
  -- The lexical search exactly as Compass runs it today, with its own order
  -- carried as the rank (rights lessons and chapter documents included).
  lexical as (
    select s.source_id, s.kind, s.title, s.ref, s.snippet, s.rank::integer as rank
    from public.search_member_kb(p_query, 6)
      with ordinality as s(source_id, kind, title, ref, snippet, rank)
  ),
  -- Best chunk per article by cosine distance, under the article gates and
  -- only for chunks cut from the article's current body.
  nearest_chunks as materialized (
    select a.id, a.slug, a.kind, a.title, a.article_ref, e.chunk,
      (e.embedding operator(extensions.<=>) p_embedding) as distance
    from public.member_kb_article_embeddings e
    join public.member_kb_articles a on a.id = e.article_id
    where p_embedding is not null and extensions.vector_norm(p_embedding) > 0
      and e.model = 'bge-m3'
      and e.digest = 'sha256:7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab'
      and a.chapter_id = private.current_member_chapter()
      and not a.is_sample
      and a.status = 'published'
      and a.verified_by is not null
      and a.verified_at is not null
      and private.knowledge_article_content_current(a)
      and e.body_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(a.body, 'UTF8')), 'hex')
    order by e.embedding operator(extensions.<=>) p_embedding
    limit 64
  ),
  semantic_chunks as (
    select distinct on (id) * from nearest_chunks
    order by id, distance, chunk
  ),
  semantic as (
    select 'kb:' || c.slug as source_id, c.kind, c.title, c.article_ref as ref,
           pg_catalog.left(c.chunk, 320) as snippet,
           (pg_catalog.row_number() over (order by c.distance, c.slug))::integer as rank
    from semantic_chunks c
    order by c.distance, c.slug
    limit 6
  ),
  candidates as (
    select 1 as origin, m.* from semantic m
    union all
    select 2 as origin, l.* from lexical l
  ),
  -- Reciprocal rank fusion, k = 60. When both lanes return the same source
  -- the semantic chunk is the snippet (it is the passage that matched).
  fused as (
    select c.source_id,
           (pg_catalog.array_agg(c.kind order by c.origin))[1] as kind,
           (pg_catalog.array_agg(c.title order by c.origin))[1] as title,
           (pg_catalog.array_agg(c.ref order by c.origin))[1] as ref,
           (pg_catalog.array_agg(c.snippet order by c.origin))[1] as snippet,
           pg_catalog.sum(1.0 / (60 + c.rank)) as score,
           pg_catalog.min(c.rank) as best_rank
    from candidates c
    group by c.source_id
  )
  select f.source_id, f.kind, f.title, f.ref, f.snippet
  from fused f
  order by f.score desc, f.best_rank asc, f.source_id
  limit (select n from lim)
$$;

revoke all on function public.search_member_kb_hybrid(text, extensions.vector, integer) from public, anon, authenticated, service_role;
grant execute on function public.search_member_kb_hybrid(text, extensions.vector, integer) to authenticated, service_role;

comment on function public.search_member_kb_hybrid(text, extensions.vector, integer) is
  'Compass hybrid retrieval: search_member_kb (unchanged) fused by reciprocal rank with a cosine top-k over member_kb_article_embeddings under the same chapter, sample, status, verification and knowledge_article_content_current gates. Security INVOKER; a null p_embedding is the lexical ranking.';

commit;
