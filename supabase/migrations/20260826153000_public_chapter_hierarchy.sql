-- MI1 CR-114: durable, tenant-bound chapter microsite sections and pages.
-- Public callers continue to cross only get_public_chapter_microsite; direct
-- table access remains staff-only and MFA-restricted.

set local lock_timeout = '5s';

alter table public.public_site_records
  add constraint public_site_records_organization_id_id_key
  unique (organization_id, id);

create table public.public_chapter_sections (
  organization_id uuid not null,
  chapter_code text not null,
  slug text not null,
  title_en text not null,
  title_es text not null,
  body_en text not null,
  body_es text not null,
  sort_order integer not null default 0,
  is_published boolean not null default false,
  published_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, chapter_code, slug),
  constraint public_chapter_sections_chapter_fk
    foreign key (organization_id, chapter_code)
    references public.public_site_records (organization_id, id)
    on update cascade on delete cascade,
  constraint public_chapter_sections_slug_bounded check (
    slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'
  ),
  constraint public_chapter_sections_copy_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(title_en)) between 1 and 120
    and pg_catalog.char_length(pg_catalog.btrim(title_es)) between 1 and 120
    and pg_catalog.char_length(pg_catalog.btrim(body_en)) between 1 and 2000
    and pg_catalog.char_length(pg_catalog.btrim(body_es)) between 1 and 2000
  ),
  constraint public_chapter_sections_publication_stamp check (
    not is_published or published_at is not null
  )
);

create table public.public_chapter_pages (
  organization_id uuid not null,
  chapter_code text not null,
  section_slug text not null,
  slug text not null,
  title_en text not null,
  title_es text not null,
  body_en text not null,
  body_es text not null,
  sort_order integer not null default 0,
  is_published boolean not null default false,
  published_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, chapter_code, section_slug, slug),
  constraint public_chapter_pages_section_fk
    foreign key (organization_id, chapter_code, section_slug)
    references public.public_chapter_sections (organization_id, chapter_code, slug)
    on update cascade on delete cascade,
  constraint public_chapter_pages_slug_bounded check (
    slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'
  ),
  constraint public_chapter_pages_copy_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(title_en)) between 1 and 120
    and pg_catalog.char_length(pg_catalog.btrim(title_es)) between 1 and 120
    and pg_catalog.char_length(pg_catalog.btrim(body_en)) between 1 and 10000
    and pg_catalog.char_length(pg_catalog.btrim(body_es)) between 1 and 10000
  ),
  constraint public_chapter_pages_publication_stamp check (
    not is_published or published_at is not null
  )
);

create index public_chapter_sections_published_idx
  on public.public_chapter_sections (organization_id, chapter_code, sort_order, slug)
  where is_published;

create index public_chapter_pages_published_idx
  on public.public_chapter_pages (
    organization_id, chapter_code, section_slug, sort_order, slug
  ) where is_published;

alter table public.public_chapter_sections enable row level security;
alter table public.public_chapter_pages enable row level security;

create policy mfa_assurance on public.public_chapter_sections
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

create policy mfa_assurance on public.public_chapter_pages
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

create policy public_chapter_sections_staff_read on public.public_chapter_sections
  for select to authenticated
  using (private.has_organization_role(
    organization_id,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ));

create policy public_chapter_sections_staff_create on public.public_chapter_sections
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and private.has_organization_role(
      organization_id,
      array['steward', 'coordinator', 'advisor', 'admin', 'vp']
    )
  );

create policy public_chapter_sections_staff_update on public.public_chapter_sections
  for update to authenticated
  using (private.has_organization_role(
    organization_id,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ))
  with check (private.has_organization_role(
    organization_id,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ));

create policy public_chapter_sections_staff_delete on public.public_chapter_sections
  for delete to authenticated
  using (private.has_organization_role(
    organization_id,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ));

create policy public_chapter_pages_staff_read on public.public_chapter_pages
  for select to authenticated
  using (private.has_organization_role(
    organization_id,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ));

create policy public_chapter_pages_staff_create on public.public_chapter_pages
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and private.has_organization_role(
      organization_id,
      array['steward', 'coordinator', 'advisor', 'admin', 'vp']
    )
  );

create policy public_chapter_pages_staff_update on public.public_chapter_pages
  for update to authenticated
  using (private.has_organization_role(
    organization_id,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ))
  with check (private.has_organization_role(
    organization_id,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ));

create policy public_chapter_pages_staff_delete on public.public_chapter_pages
  for delete to authenticated
  using (private.has_organization_role(
    organization_id,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ));

revoke all on public.public_chapter_sections from public, anon, authenticated;
revoke all on public.public_chapter_pages from public, anon, authenticated;
grant select, insert, update, delete on public.public_chapter_sections to authenticated;
grant select, insert, update, delete on public.public_chapter_pages to authenticated;

create function private.mi1_validate_public_chapter_hierarchy()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE' and (
    new.organization_id is distinct from old.organization_id
    or new.chapter_code is distinct from old.chapter_code
    or new.slug is distinct from old.slug
  ) then
    raise exception 'public chapter hierarchy identity is immutable'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
     and tg_table_name = 'public_chapter_pages'
     and (pg_catalog.to_jsonb(new) ->> 'section_slug')
       is distinct from (pg_catalog.to_jsonb(old) ->> 'section_slug') then
    raise exception 'public chapter hierarchy identity is immutable'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.public_site_records r
    where r.organization_id = new.organization_id
      and r.id = new.chapter_code
      and r.kind = 'chapter'
  ) then
    raise exception 'public chapter hierarchy requires a same-organization chapter'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

revoke all on function private.mi1_validate_public_chapter_hierarchy()
  from public, anon, authenticated, service_role;

create trigger public_chapter_sections_validate
before insert or update on public.public_chapter_sections
for each row execute function private.mi1_validate_public_chapter_hierarchy();

create trigger public_chapter_pages_validate
before insert or update on public.public_chapter_pages
for each row execute function private.mi1_validate_public_chapter_hierarchy();

create trigger public_chapter_sections_touch_updated_at
before update on public.public_chapter_sections
for each row execute function private.touch_updated_at();

create trigger public_chapter_pages_touch_updated_at
before update on public.public_chapter_pages
for each row execute function private.touch_updated_at();

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
    'id', r.id,
    'title', case when wanted = 'es' then r.title_es else r.title_en end,
    'body', case when wanted = 'es' then r.body_es else r.body_en end,
    'region', case when wanted = 'es' then r.region_es else r.region_en end,
    'url', r.url,
    'sections', coalesce((
      select pg_catalog.jsonb_agg(s.item order by s.sort_order, s.slug)
      from (
        select
          section.sort_order,
          section.slug,
          pg_catalog.jsonb_build_object(
            'id', section.slug,
            'title', case when wanted = 'es' then section.title_es else section.title_en end,
            'body', case when wanted = 'es' then section.body_es else section.body_en end,
            'pages', coalesce((
              select pg_catalog.jsonb_agg(p.item order by p.sort_order, p.slug)
              from (
                select
                  page.sort_order,
                  page.slug,
                  pg_catalog.jsonb_build_object(
                    'id', page.slug,
                    'title', case when wanted = 'es' then page.title_es else page.title_en end,
                    'body', case when wanted = 'es' then page.body_es else page.body_en end
                  ) as item
                from public.public_chapter_pages page
                where page.organization_id = section.organization_id
                  and page.chapter_code = section.chapter_code
                  and page.section_slug = section.slug
                  and page.is_published
                order by page.sort_order, page.slug
                limit 24
              ) p
            ), '[]'::jsonb)
          ) as item
        from public.public_chapter_sections section
        where section.organization_id = r.organization_id
          and section.chapter_code = r.id
          and section.is_published
        order by section.sort_order, section.slug
        limit 24
      ) s
    ), '[]'::jsonb),
    'events', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', e.id,
        'title', case when wanted = 'es' then e.title_es else e.title_en end,
        'body', case when wanted = 'es' then e.body_es else e.body_en end,
        'startsAt', e.starts_at,
        'endsAt', e.ends_at,
        'location', case when wanted = 'es' then e.location_es else e.location_en end,
        'url', e.url,
        'chapterCode', e.chapter_code,
        'category', 'meeting'
      ) order by e.starts_at, e.id)
      from (
        select source.*
        from public.public_site_records source
        where source.is_published
          and source.kind = 'meeting'
          and source.organization_id = r.organization_id
          and source.chapter_code = r.id
        order by source.starts_at, source.id
        limit 100
      ) e
    ), '[]'::jsonb)
  ) into chapter
  from public.public_site_records r
  where r.id = p_chapter_code
    and r.is_published
    and r.kind = 'chapter'
    and r.organization_id is not null;

  return chapter;
end;
$function$;

revoke all on function public.get_public_chapter_microsite(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_public_chapter_microsite(text, text)
  to anon, authenticated, service_role;

comment on table public.public_chapter_sections is
  'Published chapter microsite sections. Tenant and route identity are immutable.';
comment on table public.public_chapter_pages is
  'Published pages nested under a same-tenant public chapter section.';
