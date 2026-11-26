-- UB-PUB-01 / UB-PUB-02: public, explicitly publishable union information
-- and a durable contact-intent path. Nothing here widens anonymous access to
-- member events, cases, profiles, or chapter work. Public reads cross one
-- bounded definer projection; public writes cross one validated definer RPC.

create table public.public_site_records (
  id text primary key,
  kind text not null check (kind in ('chapter', 'win', 'meeting')),
  title_en text not null,
  title_es text not null,
  body_en text not null,
  body_es text not null,
  region_en text,
  region_es text,
  location_en text,
  location_es text,
  occurred_on date,
  starts_at timestamptz,
  ends_at timestamptz,
  url text,
  sort_order integer not null default 0,
  is_published boolean not null default false,
  published_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint public_site_records_id_bounded check (
    id ~ '^[a-z0-9][a-z0-9-]{2,63}$'
  ),
  constraint public_site_records_copy_bounded check (
    char_length(pg_catalog.btrim(title_en)) between 1 and 120
    and char_length(pg_catalog.btrim(title_es)) between 1 and 120
    and char_length(pg_catalog.btrim(body_en)) between 1 and 600
    and char_length(pg_catalog.btrim(body_es)) between 1 and 600
  ),
  constraint public_site_records_url_safe check (
    url is null or (
      char_length(url) between 9 and 500
      and url ~ '^https://[^[:space:]]+$'
    )
  ),
  constraint public_site_records_shape check (
    (kind = 'chapter'
      and region_en is not null and region_es is not null
      and occurred_on is null and starts_at is null and ends_at is null
      and location_en is null and location_es is null)
    or
    (kind = 'win'
      and occurred_on is not null
      and region_en is null and region_es is null
      and starts_at is null and ends_at is null
      and location_en is null and location_es is null)
    or
    (kind = 'meeting'
      and starts_at is not null
      and location_en is not null and location_es is not null
      and region_en is null and region_es is null
      and occurred_on is null
      and (ends_at is null or ends_at > starts_at))
  ),
  constraint public_site_records_publication_stamp check (
    not is_published or published_at is not null
  )
);

create index public_site_records_published_kind_idx
  on public.public_site_records (kind, sort_order, published_at desc)
  where is_published;
create index public_site_records_upcoming_meetings_idx
  on public.public_site_records (starts_at, sort_order)
  where is_published and kind = 'meeting';

create table public.public_interest_submissions (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text,
  interest text not null check (interest in ('chapter_updates', 'public_meetings', 'union_news')),
  locale text not null check (locale in ('en', 'es')),
  source text not null check (source = 'public-landing'),
  status text not null default 'new' check (status in ('new', 'contacted', 'closed')),
  consent_at timestamptz not null default now(),
  last_submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint public_interest_submissions_email_normalized check (
    email = pg_catalog.lower(pg_catalog.btrim(email))
    and char_length(email) between 3 and 254
  ),
  constraint public_interest_submissions_name_bounded check (
    name is null or char_length(name) between 1 and 100
  ),
  constraint public_interest_submissions_email_interest_key unique (email, interest)
);

create index public_interest_submissions_followup_idx
  on public.public_interest_submissions (status, last_submitted_at desc);

alter table public.public_site_records enable row level security;
alter table public.public_interest_submissions enable row level security;

-- New RLS tables land after the repository-wide MFA loop, so they carry the
-- restrictive policy explicitly. Anonymous callers never touch these tables:
-- SECURITY DEFINER functions below are the only public boundary.
create policy mfa_assurance on public.public_site_records
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.public_interest_submissions
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

create policy public_site_records_staff_read on public.public_site_records
  for select to authenticated
  using (public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']));
create policy public_site_records_staff_create on public.public_site_records
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
  );
create policy public_site_records_staff_update on public.public_site_records
  for update to authenticated
  using (public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
  with check (public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']));
create policy public_site_records_staff_delete on public.public_site_records
  for delete to authenticated
  using (public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']));

-- Contact details are follow-up data, not public data. Only the coordinator,
-- admin, and president hats can read the queue, after the MFA policy above.
create policy public_interest_submissions_staff_read on public.public_interest_submissions
  for select to authenticated
  using (public.member_has_role(array['coordinator', 'admin', 'vp']));

revoke all on public.public_site_records from public, anon, authenticated;
revoke all on public.public_interest_submissions from public, anon, authenticated;
grant select, insert, update, delete on public.public_site_records to authenticated;
grant select on public.public_interest_submissions to authenticated;

create function public.get_public_site_content(p_locale text)
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
        where r.is_published and r.kind = 'chapter'
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
        where r.is_published and r.kind = 'win'
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
          and coalesce(r.ends_at, r.starts_at + interval '2 hours') >= now()
        order by r.starts_at, r.sort_order, r.id
        limit 12
      ) m
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

create function public.submit_public_interest(
  p_email text,
  p_name text,
  p_interest text,
  p_locale text,
  p_source text,
  p_website text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  normalized_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  normalized_name text := nullif(pg_catalog.btrim(coalesce(p_name, '')), '');
begin
  -- Honeypot submissions receive the same answer without creating a row, so
  -- automation gets no feedback that would help it tune around the field.
  if pg_catalog.btrim(coalesce(p_website, '')) <> '' then
    return pg_catalog.jsonb_build_object('accepted', true);
  end if;

  if char_length(normalized_email) > 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'a valid email address is required' using errcode = '22023';
  end if;
  if normalized_name is not null and char_length(normalized_name) > 100 then
    raise exception 'name is too long' using errcode = '22023';
  end if;
  if p_interest not in ('chapter_updates', 'public_meetings', 'union_news') then
    raise exception 'invalid interest' using errcode = '22023';
  end if;
  if p_locale not in ('en', 'es') then
    raise exception 'invalid locale' using errcode = '22023';
  end if;
  if p_source <> 'public-landing' then
    raise exception 'invalid source' using errcode = '22023';
  end if;

  insert into public.public_interest_submissions (
    email, name, interest, locale, source
  ) values (
    normalized_email, normalized_name, p_interest, p_locale, p_source
  )
  on conflict (email, interest) do update set
    name = coalesce(excluded.name, public_interest_submissions.name),
    locale = excluded.locale,
    source = excluded.source,
    status = 'new',
    consent_at = now(),
    last_submitted_at = now();

  return pg_catalog.jsonb_build_object('accepted', true);
end;
$$;

revoke all on function public.get_public_site_content(text)
  from public, anon, authenticated, service_role;
revoke all on function public.submit_public_interest(text, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_public_site_content(text) to anon, authenticated, service_role;
grant execute on function public.submit_public_interest(text, text, text, text, text, text) to anon, authenticated, service_role;

comment on table public.public_site_records is
  'Explicitly publishable public-site projection. Never derived implicitly from member-private tables.';
comment on table public.public_interest_submissions is
  'Consent-bearing public contact intent; direct reads require a follow-up staff role and MFA.';
