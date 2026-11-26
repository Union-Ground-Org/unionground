-- REQ-UG-COMPASS-HYBRID-RETRIEVAL-HYGIENE-20261004
-- Compass hybrid retrieval hygiene (multi-tenant plan, delivery 3).
--
-- 1. Iterative HNSW scan. search_member_kb_hybrid applies the active
--    organization, scope and publication gates after the HNSW index scan.
--    pgvector stops that scan after hnsw.ef_search candidates (default 40), so
--    an organization whose chunks are outnumbered by nearer chunks from other
--    organizations received no semantic candidates at all. relaxed_order lets
--    the scan continue until the filtered candidate query has its 64 rows (or
--    hnsw.max_scan_tuples is reached). The materialized candidate CTE already
--    re-sorts by exact distance, so relaxed ordering changes no ranking.
-- 2. Readiness. get_compass_ai_context('hybrid_ready') reports whether the
--    caller's active organization has at least one current, eligible chunk,
--    under the same gates as the semantic lane. api/guide.js asks before it
--    authorizes an embedding dispatch, so an empty or stale index costs one
--    lookup instead of an authorization RPC and an embedding call of up to
--    four seconds. The answer is only a hint: retrieval still enforces every
--    gate itself.
--
-- No data change. Hosted application: SAMPLE first, then production, by the
-- sole authorized applier.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_extension
    where extname = 'vector'
      and pg_catalog.string_to_array(pg_catalog.split_part(extversion, '-', 1), '.')::integer[] >= array[0, 8, 0]
  ) then
    raise exception 'pgvector 0.8.0 or later is required for hnsw.iterative_scan';
  end if;
  -- Load pgvector so its settings exist and the value below is validated now
  -- rather than on the first member request.
  perform '[1]'::extensions.vector;
end;
$$;

alter function public.search_member_kb_hybrid(text, extensions.vector, integer)
  set hnsw.iterative_scan = 'relaxed_order';

create or replace function public.get_compass_ai_context(p_kind text, p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  org uuid := private.compass_context_organization();
  data jsonb; campaign jsonb; official jsonb; address jsonb; bill jsonb;
begin
  if p_kind = 'portal' then
    data := public.get_member_guide_context();
  elsif p_kind = 'lexical' then
    select coalesce(pg_catalog.jsonb_agg(projected.source order by r.ordinal), '[]'::jsonb) into data
    from public.search_member_kb(p_args ->> 'p_query', 4) with ordinality r(source_id, kind, title, ref, snippet, ordinal)
    cross join lateral (select private.compass_classified_source(pg_catalog.to_jsonb(r) - 'ordinal') as source) projected
    where projected.source is not null;
  elsif p_kind = 'hybrid' then
    select coalesce(pg_catalog.jsonb_agg(projected.source order by r.ordinal), '[]'::jsonb) into data
    from public.search_member_kb_hybrid(p_args ->> 'p_query', (p_args ->> 'p_embedding')::extensions.vector, 4) with ordinality r(source_id, kind, title, ref, snippet, ordinal)
    cross join lateral (select private.compass_classified_source(pg_catalog.to_jsonb(r) - 'ordinal') as source) projected
    where projected.source is not null;
  elsif p_kind = 'hybrid_ready' then
    -- The semantic lane's own gates, without a query vector: one current chunk
    -- of an eligible article in the active organization's scope is enough.
    select pg_catalog.to_jsonb(exists (
      select 1
      from public.member_kb_article_embeddings e
      join public.member_kb_articles a on a.id = e.article_id
      where a.compass_organization_id = org
        and e.compass_organization_id = org
        and e.model = 'bge-m3'
        and e.digest = 'sha256:7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab'
        and private.compass_article_scope_current(a)
        and private.compass_scope_specificity(a.compass_organization_id, a.compass_scope_path, a.compass_scope_level) > 0
        and not a.is_sample
        and a.status = 'published'
        and a.verified_by is not null
        and a.verified_at is not null
        and private.knowledge_article_content_current(a)
        and private.compass_article_classification_current(a)
        and e.compass_scope_path = a.compass_scope_path
        and e.classification_sha256 = a.compass_classification ->> 'input_sha256'
        and e.body_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(a.body, 'UTF8')), 'hex')
    )) into data;
  elsif p_kind = 'briefing' then
    data := public.get_message_briefing_context(p_args ->> 'p_source_kind', (p_args ->> 'p_target_id')::uuid);
  elsif p_kind = 'civic' then
    select pg_catalog.jsonb_build_object('id', c.id, 'topic', c.topic, 'summary', c.summary,
      'talking_points', c.talking_points, 'union_position', c.union_position, 'bill_key', c.bill_key,
      'target_offices', c.target_offices) into campaign
    from public.civic_campaigns c where c.id = (p_args ->> 'campaignId')::uuid and c.status = 'active';
    select pg_catalog.jsonb_build_object('full_name', o.full_name, 'office', o.office) into official
    from public.civic_member_officials_keyed o
    where o.user_id = (select auth.uid()) and o.official_key = p_args ->> 'officialKey' limit 1;
    select pg_catalog.jsonb_build_object('city', a.city, 'state', a.state) into address
    from public.civic_member_addresses a limit 1;
    select pg_catalog.jsonb_build_object('identifier', b.identifier, 'title', b.title) into bill
    from public.civic_bills b where b.bill_key = campaign ->> 'bill_key' limit 1;
    data := pg_catalog.jsonb_build_object('campaign', campaign, 'official', official,
      'address', coalesce(address, '{}'::jsonb), 'bill', bill);
  else raise exception 'context kind invalid' using errcode = '22023';
  end if;
  if p_kind in ('lexical', 'hybrid') then
    return pg_catalog.jsonb_build_object('organization_id', org, 'data', data,
      'scope', private.compass_retrieval_scope_summary(p_args ->> 'p_query', data));
  end if;
  return pg_catalog.jsonb_build_object('organization_id', org, 'data', data);
end;
$$;

notify pgrst, 'reload schema';
commit;
