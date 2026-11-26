begin;

-- SEC-UG-PUBLIC-MICROSITE-PUBLISHES-STAFF-ONLY-DOCUMENTS-20260908:
-- ship the write-side refusal and read-side filter together. The trigger
-- refuses new attachments to staff-only documents, while the public RPC
-- removes already-attached documents whose visibility is later switched to
-- staff.

create or replace function private.validate_public_chapter_page_attachment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not exists (
    select 1
    from public.chapter_documents document
    join public.chapters chapter on chapter.id = document.chapter_id
    where document.id = new.chapter_document_id
      and document.chapter_id = new.chapter_code
      and document.status = 'published'
      and document.visibility = 'chapter'
      and chapter.organization_id = new.organization_id
  ) then
    raise exception 'published same-chapter document required' using errcode = '23514';
  end if;
  return new;
end;
$function$;

revoke all on function private.validate_public_chapter_page_attachment()
  from public, anon, authenticated, service_role;

-- Re-emitting the trigger function changes its reviewed lifecycle-manifest
-- definition hash. Reconcile the exact four-part review key before the
-- migration's fail-closed live assertion below.
update private.account_lifecycle_trigger_review review
set definition_hash = surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
where surface.kind = review.kind
  and surface.schema_name = review.schema_name
  and surface.table_name = review.table_name
  and surface.object_name = review.object_name
  and review.kind = 'function'
  and review.schema_name = 'private'
  and review.table_name = ''
  and review.object_name = 'validate_public_chapter_page_attachment()';

do $assert_account_lifecycle_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after microsite repair';
  end if;
end;
$assert_account_lifecycle_trigger_review$;

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
        select source.*
        from public.public_site_records source
        where source.is_published and source.kind = 'meeting'
          and source.organization_id = record.organization_id
          and source.chapter_code = record.id
        order by source.starts_at, source.id
        limit 100
      ) event
    ), '[]'::jsonb)
  ) into chapter
  from public.public_site_records record
  where record.id = p_chapter_code
    and record.is_published and record.kind = 'chapter'
    and record.organization_id is not null;
  return chapter;
end;
$function$;

revoke all on function public.get_public_chapter_microsite(text, text)
  from public, anon, authenticated, service_role;

grant execute on function public.get_public_chapter_microsite(text, text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
