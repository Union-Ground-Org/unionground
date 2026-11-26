-- Keep the canonical Library/editor on the same explicitly authorized chapter
-- as CBA review. Table RLS remains unchanged; these bounded RPCs validate the
-- selected organization and chapter before their definer-owned reads/writes.

set local lock_timeout = '5s';
set local statement_timeout = '30s';

drop function if exists public.list_accessible_knowledge_articles_snapshot(boolean);

create function public.list_accessible_knowledge_articles_snapshot(
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

revoke all on function public.list_accessible_knowledge_articles_snapshot(boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_accessible_knowledge_articles_snapshot(boolean, text)
  to authenticated;

comment on function public.list_accessible_knowledge_articles_snapshot(boolean, text) is
  'Returns one statement-consistent chapter corpus. Member reads stay on the current chapter and verified publication boundary; staff may explicitly select only a chapter in their active organization.';

drop function if exists public.save_chapter_kb_article(uuid, text, text, text, text, text[], text, boolean);

create function public.save_chapter_kb_article(
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
    keywords, changed_by, verified_by, verified_at
  ) values (
    saved.id, saved.chapter_id, saved.version, saved.status, saved.kind,
    saved.title, saved.article_ref, saved.body, saved.keywords, caller,
    saved.verified_by, saved.verified_at
  );

  return saved;
end;
$function$;

revoke all on function public.save_chapter_kb_article(
  uuid, text, text, text, text, text[], text, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.save_chapter_kb_article(
  uuid, text, text, text, text, text[], text, boolean, text
) to authenticated;

drop function if exists public.retire_chapter_kb_article(uuid);

create function public.retire_chapter_kb_article(
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

  update public.member_kb_articles
     set status = 'retired',
         version = version + 1,
         updated_by = caller,
         updated_at = pg_catalog.now()
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
$function$;

revoke all on function public.retire_chapter_kb_article(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.retire_chapter_kb_article(uuid, text)
  to authenticated;

comment on function public.save_chapter_kb_article(
  uuid, text, text, text, text, text[], text, boolean, text
) is 'Creates or edits a Compass source in the caller current chapter or an explicitly selected same-organization chapter authorized to organization staff.';
comment on function public.retire_chapter_kb_article(uuid, text) is
  'Soft-retires a Compass source in the caller current chapter or an explicitly selected same-organization chapter authorized to organization staff.';
