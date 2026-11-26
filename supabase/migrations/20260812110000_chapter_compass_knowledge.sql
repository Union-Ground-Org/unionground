-- UB-RGT-01: authoritative, chapter-scoped Compass knowledge.
--
-- The original nine rows are fictional prototype copy. Preserve them as
-- historical SAMPLE data, but fail closed: they receive no chapter, cannot be
-- selected through live RLS, and are excluded explicitly from retrieval.

alter table public.member_kb_articles
  add column chapter_id text references public.chapters(id) on update cascade on delete restrict,
  add column status text not null default 'draft',
  add column is_sample boolean not null default false,
  add column version integer not null default 1,
  add column created_by uuid references auth.users(id) on delete restrict,
  add column updated_by uuid references auth.users(id) on delete restrict,
  add column verified_by uuid references auth.users(id) on delete restrict,
  add column verified_at timestamptz,
  add column updated_at timestamptz not null default now();

-- All rows that predate chapter ownership are the fictional seed corpus. No
-- title/body matching is used: a later copy edit must never let one escape.
update public.member_kb_articles
   set status = 'retired',
       is_sample = true,
       chapter_id = null,
       created_by = null,
       updated_by = null,
       verified_by = null,
       verified_at = null,
       updated_at = now()
 where chapter_id is null;

alter table public.member_kb_articles
  add constraint member_kb_articles_status_check
    check (status in ('draft', 'published', 'retired')),
  add constraint member_kb_articles_version_check
    check (version > 0),
  add constraint member_kb_articles_title_bounded
    check (pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 200),
  add constraint member_kb_articles_ref_bounded
    check (pg_catalog.char_length(pg_catalog.btrim(article_ref)) between 1 and 120),
  add constraint member_kb_articles_body_bounded
    check (pg_catalog.char_length(pg_catalog.btrim(body)) between 1 and 100000),
  add constraint member_kb_articles_keywords_bounded
    check (pg_catalog.cardinality(keywords) <= 30),
  add constraint member_kb_articles_scope_check
    check (
      (is_sample and chapter_id is null)
      or
      (not is_sample and chapter_id is not null and created_by is not null and updated_by is not null)
    ),
  add constraint member_kb_articles_published_verified
    check (
      status <> 'published'
      or (not is_sample and chapter_id is not null and verified_by is not null and verified_at is not null)
    );

create index member_kb_articles_chapter_status_order_idx
  on public.member_kb_articles (chapter_id, status, order_index)
  where not is_sample;

create table public.member_kb_article_revisions (
  id bigint generated always as identity primary key,
  article_id uuid not null references public.member_kb_articles(id) on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  version integer not null check (version > 0),
  status text not null check (status in ('draft', 'published', 'retired')),
  kind text not null check (kind in ('contract', 'rights', 'faq')),
  title text not null,
  article_ref text not null,
  body text not null,
  keywords text[] not null default '{}',
  changed_by uuid not null references auth.users(id) on delete restrict,
  verified_by uuid references auth.users(id) on delete restrict,
  verified_at timestamptz,
  changed_at timestamptz not null default now(),
  constraint member_kb_article_revisions_title_bounded
    check (pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 200),
  constraint member_kb_article_revisions_ref_bounded
    check (pg_catalog.char_length(pg_catalog.btrim(article_ref)) between 1 and 120),
  constraint member_kb_article_revisions_body_bounded
    check (pg_catalog.char_length(pg_catalog.btrim(body)) between 1 and 100000),
  constraint member_kb_article_revisions_keywords_bounded
    check (pg_catalog.cardinality(keywords) <= 30),
  unique (article_id, version)
);

create index member_kb_article_revisions_article_version_idx
  on public.member_kb_article_revisions (article_id, version desc);

alter table public.member_kb_articles enable row level security;
alter table public.member_kb_articles force row level security;
alter table public.member_kb_article_revisions enable row level security;
alter table public.member_kb_article_revisions force row level security;

-- This table is created after the 20260724030000 assurance sweep, so add the
-- same restrictive policy explicitly. It remains belt-and-braces while the
-- revision table has no permissive policy or client grant.
create policy mfa_assurance
  on public.member_kb_article_revisions
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

drop policy if exists member_kb_articles_read_authenticated on public.member_kb_articles;
drop policy if exists member_kb_articles_member_read on public.member_kb_articles;
create policy member_kb_articles_member_read
  on public.member_kb_articles for select to authenticated
  using (
    chapter_id = private.current_member_chapter()
    and not is_sample
    and status = 'published'
    and verified_by is not null
    and verified_at is not null
  );

drop policy if exists member_kb_articles_staff_read on public.member_kb_articles;
create policy member_kb_articles_staff_read
  on public.member_kb_articles for select to authenticated
  using (
    chapter_id = private.current_member_chapter()
    and not is_sample
    and public.member_has_role(array['steward','coordinator','advisor','admin','vp'])
  );

revoke all on table public.member_kb_articles from public, anon, authenticated;
grant select on table public.member_kb_articles to authenticated;
revoke all on table public.member_kb_article_revisions from public, anon, authenticated;
revoke all on sequence public.member_kb_article_revisions_id_seq from public, anon, authenticated;

create or replace function public.save_chapter_kb_article(
  p_article_id uuid,
  p_kind text,
  p_title text,
  p_article_ref text,
  p_body text,
  p_keywords text[],
  p_status text,
  p_confirm_verified boolean
)
returns public.member_kb_articles
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
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
     or not public.member_has_role(array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'staff role and required assurance level required' using errcode = '42501';
  end if;

  select private.current_member_chapter() into caller_chapter;
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
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
      coalesce(pg_catalog.max(a.order_index), 0) + 1,
      caller_chapter,
      clean_status,
      false,
      1,
      caller,
      caller,
      case when clean_status = 'published' then caller else null end,
      case when clean_status = 'published' then now() else null end,
      now()
    from public.member_kb_articles a
    where a.chapter_id = caller_chapter
    returning * into saved;
  else
    select * into saved
    from public.member_kb_articles a
    where a.id = p_article_id
      and a.chapter_id = caller_chapter
      and not a.is_sample
    for update;

    if not found then
      raise exception 'knowledge article is not available in this chapter' using errcode = '42501';
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
           verified_at = case when clean_status = 'published' then now() else null end,
           updated_at = now()
     where id = p_article_id
     returning * into saved;
  end if;

  insert into public.member_kb_article_revisions (
    article_id, chapter_id, version, status, kind, title, article_ref, body,
    keywords, changed_by, verified_by, verified_at
  ) values (
    saved.id, saved.chapter_id, saved.version, saved.status, saved.kind,
    saved.title, saved.article_ref, saved.body, saved.keywords, caller,
    saved.verified_by, saved.verified_at
  );

  return saved;
end;
$$;

create or replace function public.retire_chapter_kb_article(p_article_id uuid)
returns public.member_kb_articles
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  saved public.member_kb_articles%rowtype;
begin
  if caller is null
     or not public.member_has_role(array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'staff role and required assurance level required' using errcode = '42501';
  end if;

  select private.current_member_chapter() into caller_chapter;
  if caller_chapter is null or p_article_id is null then
    raise exception 'knowledge article is not available in this chapter' using errcode = '42501';
  end if;

  select * into saved
  from public.member_kb_articles a
  where a.id = p_article_id
    and a.chapter_id = caller_chapter
    and not a.is_sample
  for update;

  if not found then
    raise exception 'knowledge article is not available in this chapter' using errcode = '42501';
  end if;

  update public.member_kb_articles
     set status = 'retired',
         version = version + 1,
         updated_by = caller,
         updated_at = now()
   where id = p_article_id
   returning * into saved;

  insert into public.member_kb_article_revisions (
    article_id, chapter_id, version, status, kind, title, article_ref, body,
    keywords, changed_by, verified_by, verified_at
  ) values (
    saved.id, saved.chapter_id, saved.version, saved.status, saved.kind,
    saved.title, saved.article_ref, saved.body, saved.keywords, caller,
    saved.verified_by, saved.verified_at
  );

  return saved;
end;
$$;

revoke all on function public.save_chapter_kb_article(uuid, text, text, text, text, text[], text, boolean) from public, anon;
grant execute on function public.save_chapter_kb_article(uuid, text, text, text, text, text[], text, boolean) to authenticated;
revoke all on function public.retire_chapter_kb_article(uuid) from public, anon;
grant execute on function public.retire_chapter_kb_article(uuid) to authenticated;

-- Preserve the existing recall-oriented rights and own-case branches, but the
-- KB branch is now doubly fail-closed: explicit state filters plus table RLS.
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
    where a.chapter_id = private.current_member_chapter()
      and not a.is_sample
      and a.status = 'published'
      and a.verified_by is not null
      and a.verified_at is not null
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

    -- UB-RGT-02 landed earlier in the same delivery train. Preserve its
    -- published chapter-library retrieval when this migration replaces the
    -- function to harden the article branch.
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

revoke all on function public.search_member_kb(text, integer) from public, anon;
grant execute on function public.search_member_kb(text, integer) to authenticated;

comment on table public.member_kb_articles is
  'Current chapter-scoped Compass knowledge. Legacy fictional rows are retained only as retired samples.';
comment on table public.member_kb_article_revisions is
  'Immutable staff-authored snapshots for every chapter Compass knowledge lifecycle change.';
