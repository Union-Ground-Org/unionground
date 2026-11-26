-- REQ-UG-COMPASS-INGESTION-CLASSIFICATION-20261002
-- Classify complete documents on ingestion/publication, never a truncated
-- retrieval snippet. No hosted apply or model dispatch is part of this migration.
begin;

alter table public.member_kb_articles
  add column compass_corpus_rule text not null default 'published-document'
    check (compass_corpus_rule in ('published-document', 'public-filing')),
  add column compass_filing jsonb,
  add column compass_classification jsonb;

comment on column public.member_kb_articles.compass_classification is
  'Ingestion-derived, versioned document classification bound to title, reference, body, rule and filing provenance. Review flags contain reason tokens and counts only; no removed text. Source verification, tenant RLS and Storage verdicts remain independent requirements.';
comment on column public.member_kb_articles.compass_filing is
  'Platform-import provenance for the public-filing rule: exact public filing identity, source URL and year. It grants no public visibility or tenant membership; shared public retrieval is a separate delivery.';

create function private.compass_document_input_sha(
  p_title text, p_ref text, p_body text, p_rule text, p_filing jsonb
) returns text language sql immutable set search_path = '' as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array(p_title, p_ref, p_body, p_rule, p_filing)::text, 'UTF8')), 'hex')
$$;
revoke all on function private.compass_document_input_sha(text, text, text, text, jsonb) from public, anon;
grant execute on function private.compass_document_input_sha(text, text, text, text, jsonb) to authenticated, service_role;

-- Sentence exclusion is conservative and bilingual. This is a deterministic
-- screen plus mandatory publisher verification, not general-purpose NER.
-- Records/case identifiers/contact details never enter either corpus. Public
-- filings may retain named officers and compensation, with filing provenance.
create function private.classify_compass_document(
  p_title text, p_ref text, p_body text,
  p_rule text default 'published-document', p_filing jsonb default null
) returns jsonb language plpgsql stable set search_path = '' as $$
declare
  value text; sentence text; clean text := ''; label text;
  excluded integer := 0; review_required boolean := false; labels_safe boolean := true;
  finding text; flags text[] := array[]::text[]; part integer := 0;
  private_record_pattern constant text :=
    '([[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}|[0-9]{3}[- ][0-9]{2}[- ][0-9]{4}|\m(case|grievance|member|employee|personnel|patient|expediente|caso|queja|miembro|empleado)\s*(id|record|number|no\.?|reference|ref|registro|número|numero)?\s*[:#]\s*[^[:space:]]+|\mGRV[-_ ][[:alnum:]]+|\m(member|employee|personnel|case|grievance|miembro|empleado|caso)[ _-]+(id|record|reference|name|registro|número|numero)[" ]*[:=#][^[:space:]]*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\m(SSN|social security( number)?|seguro social)\s*[:#=-]?\s*[0-9]{3}[- ]?[0-9]{2}[- ]?[0-9]{4}\M|[0-9]{3}[- .][0-9]{3}[- .][0-9]{4})';
  narrative_pattern constant text :=
    '(\m(i|he|she|we|they|yo|él|ella|nosotros|ellos)\s+(was|were|am|have|has|had|fui|fue|estoy|tengo|tenía)|\m(my|his|her|mi|mis|su)\s+(case|grievance|suspension|diagnosis|medical|discipline|caso|queja|suspensión|diagnóstico|expediente)|\m(the member|the employee|participant [0-9]+|el miembro|el empleado|la empleada)\s+(has|had|was|is|requested|tiene|tuvo|fue|está|solicitó)|\m(diagnosed with|has lupus|has cancer|diagnosticad[oa]|tiene lupus|tiene cáncer)\M|\m(was|were|is|has been|had been|fue|está|ha sido)\s+(suspended|disciplined|terminated|dismissed|on leave|suspendid[oa]|despedid[oa])|\m(officer|member|employee|patient|funcionario|miembro|empleado|empleada|paciente)\s+([[:alpha:]''’-]+\s+){1,4}(received|earned|reported|filed|requested|recibió|ganó|informó|presentó|solicitó)\M|\m(filed|submitted|presentó|presentaron)\s+(a |una |un )?(grievance|complaint|claim|queja|demanda)\M)';
begin
  if p_rule not in ('published-document', 'public-filing')
    or p_title is null or p_ref is null or p_body is null
    or pg_catalog.char_length(p_title) not between 1 and 500
    or pg_catalog.char_length(p_ref) not between 1 and 500
    or pg_catalog.char_length(p_body) not between 1 and 100000 then
    return pg_catalog.jsonb_build_object('version', 'compass-document-v1', 'status', 'excluded', 'flags', pg_catalog.jsonb_build_array('invalid-document'));
  end if;
  if p_rule = 'public-filing' and (
    p_filing is null or pg_catalog.jsonb_typeof(p_filing) <> 'object'
    or not (p_filing ?& array['identity','source','year'])
    or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_filing)) <> 3
    or pg_catalog.jsonb_typeof(p_filing -> 'identity') <> 'string'
    or pg_catalog.char_length(p_filing ->> 'identity') not between 1 and 200
    or pg_catalog.btrim(p_filing ->> 'identity') = ''
    or (p_filing ->> 'identity') ~ '[[:cntrl:]]'
    or pg_catalog.jsonb_typeof(p_filing -> 'source') <> 'string'
    or (p_filing ->> 'source') !~ '^https://[^[:space:]@]+$'
    or pg_catalog.char_length(p_filing ->> 'source') > 1000
    or pg_catalog.jsonb_typeof(p_filing -> 'year') <> 'number'
    or (p_filing ->> 'year') !~ '^(19|20)[0-9]{2}$'
  ) then
    return pg_catalog.jsonb_build_object('version', 'compass-document-v1', 'status', 'excluded', 'flags', pg_catalog.jsonb_build_array('filing-provenance-required'));
  end if;
  if p_rule = 'published-document' and p_filing is not null then
    return pg_catalog.jsonb_build_object('version', 'compass-document-v1', 'status', 'excluded', 'flags', pg_catalog.jsonb_build_array('rule-provenance-mismatch'));
  end if;
  foreach value in array array[p_title, p_ref, p_body] loop
    part := part + 1;
    label := '';
    for sentence in select pg_catalog.btrim(s) from pg_catalog.regexp_split_to_table(value, '(?<=[.!?])\s+|[\r\n]+') s loop
      if sentence = '' then continue; end if;
      finding := null;
      if sentence ~* private_record_pattern or sentence ~ '[[:cntrl:]]' then
        finding := 'member-record-or-case-reference';
      elsif p_rule = 'published-document' and sentence ~* narrative_pattern then
        finding := 'personal-narrative'; review_required := true;
      end if;
      if finding is not null then
        excluded := excluded + 1;
        if not finding = any(flags) then flags := pg_catalog.array_append(flags, finding); end if;
        if part < 3 then labels_safe := false; end if;
        continue;
      end if;
      label := label || case when label = '' then '' else ' ' end || sentence;
    end loop;
    if part = 3 then clean := label; end if;
  end loop;
  return pg_catalog.jsonb_build_object(
    'version', 'compass-document-v1', 'rule', p_rule,
    'status', case when not labels_safe or clean = '' then 'excluded' when review_required then 'review-required' else 'ready' end,
    'input_sha256', private.compass_document_input_sha(p_title, p_ref, p_body, p_rule, p_filing),
    'body_sha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_body, 'UTF8')), 'hex'),
    'text', clean, 'text_sha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(clean, 'UTF8')), 'hex'),
    'excluded_sentences', excluded, 'flags', pg_catalog.to_jsonb(flags), 'filing', p_filing);
end;
$$;
revoke all on function private.classify_compass_document(text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function private.classify_compass_document(text, text, text, text, jsonb) to service_role;

create function private.classify_compass_article_on_ingestion()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Ordinary publishing RPCs cannot choose the public-filing exception. Only
  -- the platform importer/service role or a direct owner SQL window can do so.
  if (tg_op = 'INSERT' and (new.compass_corpus_rule <> 'published-document' or new.compass_filing is not null))
    or (tg_op = 'UPDATE' and (new.compass_corpus_rule is distinct from old.compass_corpus_rule
      or new.compass_filing is distinct from old.compass_filing
      or ((old.compass_corpus_rule = 'public-filing' or new.compass_corpus_rule = 'public-filing')
        and (new.title is distinct from old.title or new.article_ref is distinct from old.article_ref
          or new.body is distinct from old.body)))) then
    if coalesce(auth.role(), '') <> 'service_role'
      and not (session_user = 'postgres' and (select auth.uid()) is null) then
      raise exception 'platform filing provenance required' using errcode = '42501';
    end if;
  end if;
  -- Ignore client-supplied classification. Reuse only the exact old receipt on
  -- an unrelated write; publication, restore and source changes classify again.
  if tg_op = 'UPDATE' and new.title is not distinct from old.title
    and new.article_ref is not distinct from old.article_ref and new.body is not distinct from old.body
    and new.status is not distinct from old.status and new.verified_by is not distinct from old.verified_by
    and new.verified_at is not distinct from old.verified_at and new.content_origin is not distinct from old.content_origin
    and new.knowledge_source_id is not distinct from old.knowledge_source_id
    and new.compass_corpus_rule is not distinct from old.compass_corpus_rule
    and new.compass_filing is not distinct from old.compass_filing
    and new.compass_classification is not null and old.compass_classification is not null then
    new.compass_classification := old.compass_classification;
  else
    new.compass_classification := private.classify_compass_document(new.title, new.article_ref, new.body, new.compass_corpus_rule, new.compass_filing);
  end if;
  return new;
end;
$$;
revoke all on function private.classify_compass_article_on_ingestion() from public, anon, authenticated, service_role;
create trigger compass_document_ingestion_classification
  before insert or update on public.member_kb_articles
  for each row execute function private.classify_compass_article_on_ingestion();

-- This trigger adds no reference or cleanup mutation. Register its definition
-- and the three new functions reachable from it in the lifecycle inventory.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where (kind = 'trigger' and schema_name = 'public' and table_name = 'member_kb_articles'
  and object_name = 'compass_document_ingestion_classification')
  or (kind = 'function' and schema_name = 'private'
    and pg_catalog.split_part(object_name, '(', 1) in (
      'classify_compass_article_on_ingestion', 'classify_compass_document', 'compass_document_input_sha'
    ));

create function private.compass_article_classification_current(a public.member_kb_articles)
returns boolean language sql stable set search_path = '' as $$
  select coalesce(a.compass_classification ->> 'version' = 'compass-document-v1'
    and a.compass_classification ->> 'status' = 'ready'
    and a.compass_classification ->> 'input_sha256' = private.compass_document_input_sha(a.title, a.article_ref, a.body, a.compass_corpus_rule, a.compass_filing), false)
$$;
revoke all on function private.compass_article_classification_current(public.member_kb_articles) from public, anon;
grant execute on function private.compass_article_classification_current(public.member_kb_articles) to authenticated, service_role;

-- Existing rows remain unclassified until the owner runs the bounded backfill
-- below, or their publisher saves/restores them. No blanket trust of old rows.
create function public.backfill_compass_document_classification(p_after uuid default null, p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  declare row record; classified jsonb; n integer := 0; ready_count integer := 0; review_count integer := 0; excluded_count integer := 0; cursor uuid;
  begin
  if p_limit is null or p_limit not between 1 and 500 then raise exception 'invalid limit' using errcode = '22023'; end if;
  for row in select a.id from public.member_kb_articles a
    where (p_after is null or a.id > p_after) order by a.id limit p_limit for update loop
    update public.member_kb_articles set compass_classification = null where id = row.id
      returning compass_classification into classified;
    -- The trigger overwrites null with a fresh classification. Reset through
    -- the dedicated classifier so existing receipts cannot be submitted as text.
    n := n + 1; cursor := row.id;
    if classified ->> 'status' = 'ready' then ready_count := ready_count + 1;
    elsif classified ->> 'status' = 'review-required' then review_count := review_count + 1;
    else excluded_count := excluded_count + 1; end if;
  end loop;
  return pg_catalog.jsonb_build_object('selected', n, 'ready', ready_count, 'reviewRequired', review_count,
    'excluded', excluded_count, 'nextCursor', case when n = 0 then null else cursor end);
  end;
end;
$$;
revoke all on function public.backfill_compass_document_classification(uuid, integer) from public, anon, authenticated;
grant execute on function public.backfill_compass_document_classification(uuid, integer) to service_role;

-- A projection can only attach assurance to the exact RLS-visible article.
-- Neither client-provided sources nor historical snippets acquire this marker.
create function private.compass_classified_source(p_source jsonb)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare a public.member_kb_articles%rowtype; title text; ref text; snippet text; receipt jsonb;
begin
  if p_source ->> 'source_id' not like 'kb:%' then return p_source; end if;
  select source.* into a from public.member_kb_articles source
    where 'kb:' || source.slug = p_source ->> 'source_id'
      and source.chapter_id = private.current_member_chapter()
      and not source.is_sample and source.status = 'published'
      and source.verified_by is not null and source.verified_at is not null
      and private.knowledge_article_content_current(source)
      and private.compass_article_classification_current(source);
  if not found then return null; end if;
  title := pg_catalog.left(pg_catalog.regexp_replace(a.title, '[[:space:]]+', ' ', 'g'), 160);
  ref := pg_catalog.left(pg_catalog.regexp_replace(a.article_ref, '[[:space:]]+', ' ', 'g'), 120);
  snippet := pg_catalog.left(a.compass_classification ->> 'text', 400);
  if pg_catalog.strpos(a.compass_classification ->> 'text', p_source ->> 'snippet') > 0 then
    snippet := pg_catalog.left(p_source ->> 'snippet', 400);
  end if;
  receipt := pg_catalog.jsonb_build_object('version', 'compass-document-v1', 'status', 'ready', 'rule', a.compass_corpus_rule,
    'filing', a.compass_filing, 'payload_sha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      title || pg_catalog.chr(31) || ref || pg_catalog.chr(31) || snippet, 'UTF8')), 'hex'));
  return p_source || pg_catalog.jsonb_build_object('title', title, 'ref', ref, 'snippet', snippet, 'document_classification', receipt);
end;
$$;
revoke all on function private.compass_classified_source(jsonb) from public, anon, service_role;
grant execute on function private.compass_classified_source(jsonb) to authenticated;

-- Apply classification eligibility before lexical ranking and the result
-- limit, so unavailable articles cannot starve approved sources.
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
      pg_catalog.left(a.compass_classification ->> 'text', 320) as snippet,
      case
        when (select ts from q) is null
          then 0.001 * (100 - least(a.order_index, 99))::double precision
        else pg_catalog.ts_rank(
          pg_catalog.to_tsvector(
            'english',
            coalesce(a.title, '') || ' ' || coalesce(a.article_ref, '') || ' ' ||
            coalesce(a.compass_classification ->> 'text', '') || ' ' || pg_catalog.array_to_string(a.keywords, ' ')
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
      and private.compass_article_classification_current(a)
      and (
        (select ts from q) is null
        or pg_catalog.to_tsvector(
             'english',
             coalesce(a.title, '') || ' ' || coalesce(a.article_ref, '') || ' ' ||
             coalesce(a.compass_classification ->> 'text', '') || ' ' || pg_catalog.array_to_string(a.keywords, ' ')
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
  return pg_catalog.jsonb_build_object('organization_id', org, 'data', data);
end;
$$;

alter table public.member_kb_article_embeddings add column classification_sha256 text
  check (classification_sha256 ~ '^[0-9a-f]{64}$');

create or replace function public.search_member_kb_hybrid(
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
      and private.compass_article_classification_current(a)
      and e.classification_sha256 = a.compass_classification ->> 'input_sha256'
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

alter policy member_kb_article_embeddings_member_read on public.member_kb_article_embeddings
  using (
    model = 'bge-m3'
    and digest = 'sha256:7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab'
    and exists (
      select 1 from public.member_kb_articles a
      where a.id = member_kb_article_embeddings.article_id
        and a.chapter_id = private.current_member_chapter()
        and not a.is_sample and a.status = 'published'
        and a.verified_by is not null and a.verified_at is not null
        and private.knowledge_article_content_current(a)
        and private.compass_article_classification_current(a)
        and classification_sha256 = a.compass_classification ->> 'input_sha256'
        and body_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(a.body, 'UTF8')), 'hex')
    )
  );
comment on policy member_kb_article_embeddings_member_read on public.member_kb_article_embeddings is
  'RLS-visible verified in-chapter articles only, with current source verdict, original body hash, pinned model/digest and exact ingestion-classification binding. Old or differently classified vectors must be backfilled before any read. No member write grant.';

notify pgrst, 'reload schema';
commit;
