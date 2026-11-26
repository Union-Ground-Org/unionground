-- #9344: own active members may read a fictional organization's published chapters.
-- a project decision,
-- item 4, addition 7:09 PM ET. Provisional stamp: renew at migration-line admission.
-- The original organization_visible_in_directory stays PUBLIC-ONLY. Standalone
-- event lists, verification, network discovery and handshakes keep that rule.
-- 9344-READ (8:27 PM ET) and 8:32 PM ET scope ruling: own members can
-- open a chapter meeting, read-only. RSVP remains behind the strict predicate.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = pg_catalog;

do $predecessors$ begin
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = 'public.get_public_site_content(text)'::regprocedure) is distinct from '8122bbbb89b43814a5905d87ca846e08' then
    raise exception 'unreviewed get_public_site_content predecessor' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = 'public.get_public_directory(text)'::regprocedure) is distinct from '7a78781a8c46fde47f61a9848a21e95f' then
    raise exception 'unreviewed get_public_directory predecessor' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = 'public.get_public_chapter_microsite(text,text)'::regprocedure) is distinct from 'b9a8b9472fcbcfd5378fd856cac0b7c3' then
    raise exception 'unreviewed get_public_chapter_microsite predecessor' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = 'public.get_public_event_detail(text,text)'::regprocedure) is distinct from '9b0c13c79bce5e40bca67f2b3d9c7e0a' then
    raise exception 'unreviewed get_public_event_detail predecessor' using errcode = '55000';
  end if;
end; $predecessors$;

-- A separate, private predicate prevents broadening all users of the public
-- visibility function. No caller-supplied user id, selected organization or
-- JWT organization claim participates in the membership decision.
create function private.organization_chapters_visible_in_directory(p_organization_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select private.organization_visible_in_directory(p_organization_id)
    or exists (
      select 1 from public.organizations o
      join public.organization_memberships m on m.organization_id = o.id
      where o.id = p_organization_id and o.is_fictional
        and m.user_id = (select auth.uid()) and m.status = 'active'
    );
$function$;
revoke all on function private.organization_chapters_visible_in_directory(uuid)
  from public, anon, authenticated, service_role;

-- Re-emitted from 20261028080000_platform_organization_boundary.sql;
-- only the chapter predicate changes. CREATE OR REPLACE preserves the ACL.
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
          and private.organization_chapters_visible_in_directory(r.organization_id)
          and private.organization_is_union(r.organization_id)
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
          and private.organization_visible_in_directory(r.organization_id)
          and private.organization_is_union(r.organization_id)
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
          and private.organization_visible_in_directory(r.organization_id)
          and private.organization_is_union(r.organization_id)
          and coalesce(r.ends_at, r.starts_at + interval '2 hours') >= now()
        order by r.starts_at, r.sort_order, r.id
        limit 12
      ) m
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

-- Re-emitted from 20261028080000_platform_organization_boundary.sql;
-- only the chapter predicate changes. CREATE OR REPLACE preserves the ACL.
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
          and private.organization_chapters_visible_in_directory(r.organization_id)
          and private.organization_is_union(r.organization_id)
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
          and private.organization_visible_in_directory(r.organization_id)
          and private.organization_is_union(r.organization_id)
          and coalesce(r.ends_at, r.starts_at + interval '2 hours') >= pg_catalog.now()
        order by r.starts_at, r.sort_order, r.id
        limit 12
      ) item
    ), '[]'::jsonb)
  );
end;
$function$;

-- Re-emitted from 20261028080000_platform_organization_boundary.sql;
-- only the chapter predicate changes. CREATE OR REPLACE preserves the ACL.
create or replace function public.get_public_chapter_microsite(
  p_chapter_code text,
  p_locale text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  wanted text := case when p_locale = 'es' then 'es' else 'en' end;
  chapter jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'id', record.id,
    'title', case when wanted = 'es' then record.title_es else record.title_en end,
    'body', case when wanted = 'es' then record.body_es else record.body_en end,
    'region', case when wanted = 'es' then record.region_es else record.region_en end,
    'url', record.url,
    'sections', coalesce((
      select pg_catalog.jsonb_agg(section_item.item order by section_item.sort_order, section_item.slug)
      from (
        select section.sort_order, section.slug,
          pg_catalog.jsonb_build_object(
            'id', section.slug,
            'title', case when wanted = 'es' then section.title_es else section.title_en end,
            'body', case when wanted = 'es' then section.body_es else section.body_en end,
            'pages', coalesce((
              select pg_catalog.jsonb_agg(page_item.item order by page_item.sort_order, page_item.slug)
              from (
                select page.sort_order, page.slug,
                  pg_catalog.jsonb_build_object(
                    'id', page.slug,
                    'title', case when wanted = 'es' then page.title_es else page.title_en end,
                    'body', case when wanted = 'es' then page.body_es else page.body_en end,
                    'attachments', coalesce((
                      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                        'id', attachment.id,
                        'label', attachment.label,
                        'title', document.title,
                        'summary', document.summary,
                        'documentType', document.document_type,
                        'sourceUrl', case
                          when document.source_url ~ '^https://[^[:space:]]+$'
                            then document.source_url
                          else null
                        end
                      ) order by attachment.attached_at, attachment.id)
                      from public.public_chapter_page_attachments attachment
                      join public.chapter_documents document
                        on document.id = attachment.chapter_document_id
                      where attachment.organization_id = page.organization_id
                        and attachment.chapter_code = page.chapter_code
                        and attachment.section_slug = page.section_slug
                        and attachment.page_slug = page.slug
                        and document.status = 'published'
                        and document.visibility = 'chapter'
                    ), '[]'::jsonb)
                  ) as item
                from public.public_chapter_pages page
                where page.organization_id = section.organization_id
                  and page.chapter_code = section.chapter_code
                  and page.section_slug = section.slug
                  and page.is_published
                order by page.sort_order, page.slug
                limit 24
              ) page_item
            ), '[]'::jsonb)
          ) as item
        from public.public_chapter_sections section
        where section.organization_id = record.organization_id
          and section.chapter_code = record.id
          and section.is_published
        order by section.sort_order, section.slug
        limit 24
      ) section_item
    ), '[]'::jsonb),
    'events', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', event.id,
        'title', case when wanted = 'es' then event.title_es else event.title_en end,
        'body', case when wanted = 'es' then event.body_es else event.body_en end,
        'startsAt', event.starts_at,
        'endsAt', event.ends_at,
        'location', case when wanted = 'es' then event.location_es else event.location_en end,
        'url', event.url,
        'chapterCode', event.chapter_code,
        'category', 'meeting'
      ) order by event.starts_at, event.id)
      from (
        (
          select source.*
          from public.public_site_records source
          where source.is_published and source.kind = 'meeting'
            and source.organization_id = record.organization_id
            and source.chapter_code = record.id
            and coalesce(source.ends_at, source.starts_at) >= pg_catalog.now()
          order by source.starts_at, source.id
          limit 100
        )
        union all
        (
          select source.*
          from public.public_site_records source
          where source.is_published and source.kind = 'meeting'
            and source.organization_id = record.organization_id
            and source.chapter_code = record.id
            and coalesce(source.ends_at, source.starts_at) < pg_catalog.now()
          order by source.starts_at desc, source.id desc
          limit 12
        )
      ) event
    ), '[]'::jsonb)
  ) into chapter
  from public.public_site_records record
  where record.id = p_chapter_code
    and record.is_published and record.kind = 'chapter'
    and record.organization_id is not null
          and private.organization_chapters_visible_in_directory(record.organization_id)
          and private.organization_is_union(record.organization_id);
  return chapter;
end;
$function$;

-- Re-emitted from 20261028080000_platform_organization_boundary.sql.
-- Only chapter-linked meetings gain the own-member read exception. The plain
-- boolean is true for every event already readable anonymously. No write RPC
-- is changed; clients may only further restrict the existing RSVP availability.
create or replace function public.get_public_event_detail(p_event_id text, p_locale text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  wanted text := case when p_locale = 'es' then 'es' else 'en' end;
  result jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'id', r.id,
    'title', case when wanted = 'es' then r.title_es else r.title_en end,
    'body', case when wanted = 'es' then r.body_es else r.body_en end,
    'startsAt', r.starts_at,
    'endsAt', r.ends_at,
    'location', case when wanted = 'es' then r.location_es else r.location_en end,
    'url', r.url,
    'chapterCode', r.chapter_code,
    'category', 'meeting',
    'rsvpAvailable', private.organization_visible_in_directory(r.organization_id)
  ) into result
  from public.public_site_records r
  where r.id = p_event_id
    and r.is_published
    and r.kind = 'meeting'
    and r.organization_id is not null
          and (private.organization_visible_in_directory(r.organization_id)
            or (r.chapter_code is not null
              and private.organization_chapters_visible_in_directory(r.organization_id)))
          and private.organization_is_union(r.organization_id);
  return result;
end;
$function$;

notify pgrst, 'reload schema';
commit;
