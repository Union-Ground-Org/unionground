-- SYS-UG-PUBLIC-LANDING-RPC-OMITS-ORGANIZATION-QUARANTINE-20260921
--
-- public.public_site_records.organization_id carries its own contract:
-- "NULL is a quarantined pre-MI1/orphan public card and never authorizes a
-- public RSVP." The three MI1 public read RPCs honour it — get_public_directory,
-- get_public_event_detail and get_public_chapter_microsite all require
-- organization_id is not null — but the landing reader defined in
-- 20260812130000 predates MI1 and was never re-emitted with the predicate. A
-- quarantined orphan card therefore still occupies one of the landing's twelve
-- chapter, win or meeting slots while every deep link into it 404s and no RSVP
-- it offers can ever be accepted.
--
-- Re-emit the landing reader with the quarantine conjunct on all three
-- subqueries. Nothing else about the projection changes: the same columns, the
-- same locale switch, the same ordering, the same limit of twelve, the same
-- upcoming-meeting recency bound. The supporting index added by
-- 20260822020000, public_site_records_organization_published_idx, is already
-- partial on `is_published and organization_id is not null`, so the filtered
-- plan is the indexed one.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.get_public_site_content(p_locale text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  wanted_locale text := case when p_locale = 'es' then 'es' else 'en' end;
  result jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(c.item order by c.sort_order, c.published_at desc, c.id)
      from (
        select
          r.id,
          r.sort_order,
          r.published_at,
          pg_catalog.jsonb_build_object(
            'id', r.id,
            'title', case when wanted_locale = 'es' then r.title_es else r.title_en end,
            'body', case when wanted_locale = 'es' then r.body_es else r.body_en end,
            'region', case when wanted_locale = 'es' then r.region_es else r.region_en end,
            'url', r.url
          ) as item
        from public.public_site_records r
        where r.is_published
          and r.kind = 'chapter'
          and r.organization_id is not null
        order by r.sort_order, r.published_at desc, r.id
        limit 12
      ) c
    ), '[]'::jsonb),
    'wins', coalesce((
      select pg_catalog.jsonb_agg(w.item order by w.sort_order, w.occurred_on desc, w.id)
      from (
        select
          r.id,
          r.sort_order,
          r.occurred_on,
          pg_catalog.jsonb_build_object(
            'id', r.id,
            'title', case when wanted_locale = 'es' then r.title_es else r.title_en end,
            'body', case when wanted_locale = 'es' then r.body_es else r.body_en end,
            'occurredOn', r.occurred_on,
            'url', r.url
          ) as item
        from public.public_site_records r
        where r.is_published
          and r.kind = 'win'
          and r.organization_id is not null
        order by r.sort_order, r.occurred_on desc, r.id
        limit 12
      ) w
    ), '[]'::jsonb),
    'meetings', coalesce((
      select pg_catalog.jsonb_agg(m.item order by m.starts_at, m.sort_order, m.id)
      from (
        select
          r.id,
          r.starts_at,
          r.sort_order,
          pg_catalog.jsonb_build_object(
            'id', r.id,
            'title', case when wanted_locale = 'es' then r.title_es else r.title_en end,
            'body', case when wanted_locale = 'es' then r.body_es else r.body_en end,
            'startsAt', r.starts_at,
            'endsAt', r.ends_at,
            'location', case when wanted_locale = 'es' then r.location_es else r.location_en end,
            'url', r.url
          ) as item
        from public.public_site_records r
        where r.is_published
          and r.kind = 'meeting'
          and r.organization_id is not null
          and coalesce(r.ends_at, r.starts_at + interval '2 hours') >= now()
        order by r.starts_at, r.sort_order, r.id
        limit 12
      ) m
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_public_site_content(text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_public_site_content(text) to anon, authenticated, service_role;

comment on function public.get_public_site_content(text) is
  'Anonymous public landing read. Returns only explicitly published chapter, win and upcoming-meeting projection rows that belong to an owning organization; quarantined pre-MI1 cards with a NULL organization_id are excluded here exactly as they are by get_public_directory, get_public_event_detail and get_public_chapter_microsite.';

notify pgrst, 'reload schema';

commit;
