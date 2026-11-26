-- Complete Compass-library reads must come from one PostgreSQL statement.
-- Client-side pagination spans multiple READ COMMITTED snapshots, so a CBA
-- reconciliation between page requests can otherwise mix old and new rows.

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create function public.list_accessible_knowledge_articles_snapshot(
  p_published_only boolean default false
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.jsonb_agg(
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
    ),
    '[]'::jsonb
  )
  from public.member_kb_articles article
  where article.chapter_id is not null
    and not article.is_sample
    and (
      not coalesce(p_published_only, false)
      or (
        article.status = 'published'
        and article.verified_by is not null
        and article.verified_at is not null
      )
    );
$function$;

revoke all on function public.list_accessible_knowledge_articles_snapshot(boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.list_accessible_knowledge_articles_snapshot(boolean)
  to authenticated;

comment on function public.list_accessible_knowledge_articles_snapshot(boolean) is
  'Returns one RLS-authorized, statement-consistent Compass-library snapshot. The optional publication predicate keeps Member-selected client surfaces fail-closed for sessions that also hold staff roles.';
