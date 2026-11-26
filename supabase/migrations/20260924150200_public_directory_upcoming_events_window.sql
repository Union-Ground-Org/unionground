-- PERF-UG-PUBLIC-DIRECTORY-UNBOUNDED-HISTORICAL-EVENTS-20260921
--
-- The anonymous public directory aggregated every published meeting oldest-
-- first with no recency predicate and no LIMIT, so the payload grew forever
-- and the events panel led with long-past meetings. Keep chapters, locale
-- handling, security definer, empty search_path, and grants unchanged.
-- Bound events to meetings that have not ended, soonest-first, with LIMIT 12
-- matching public.get_public_site_content. Wrap the LIMIT in a subselect so
-- jsonb_agg cannot swallow it.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.get_public_directory(p_locale text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  wanted text := case when p_locale = 'es' then 'es' else 'en' end;
begin
  return pg_catalog.jsonb_build_object(
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id,
        'title', case when wanted = 'es' then r.title_es else r.title_en end,
        'body', case when wanted = 'es' then r.body_es else r.body_en end,
        'region', case when wanted = 'es' then r.region_es else r.region_en end,
        'url', r.url,
        'sections', '[]'::jsonb
      ) order by r.sort_order, r.published_at desc, r.id)
      from public.public_site_records r
      where r.is_published
        and r.kind = 'chapter'
        and r.organization_id is not null
    ), '[]'::jsonb),
    'events', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.starts_at, item.sort_order, item.id)
      from (
        select
          r.id,
          r.starts_at,
          r.sort_order,
          pg_catalog.jsonb_build_object(
            'id', r.id,
            'title', case when wanted = 'es' then r.title_es else r.title_en end,
            'body', case when wanted = 'es' then r.body_es else r.body_en end,
            'startsAt', r.starts_at,
            'endsAt', r.ends_at,
            'location', case when wanted = 'es' then r.location_es else r.location_en end,
            'url', r.url,
            'chapterCode', r.chapter_code,
            'category', 'meeting'
          ) as payload
        from public.public_site_records r
        where r.is_published
          and r.kind = 'meeting'
          and r.organization_id is not null
          and coalesce(r.ends_at, r.starts_at + interval '2 hours') >= pg_catalog.now()
        order by r.starts_at, r.sort_order, r.id
        limit 12
      ) item
    ), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.get_public_directory(text)
  from public, anon, authenticated, service_role;

grant execute on function public.get_public_directory(text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
