-- REQ-UG-PLATFORM-ORG-PRODUCTION-20261012
-- Schema only: no organization is created, renamed or classified here.
-- Designation is a separate production operation after the retained cleanup
-- completion and the operator's exact kept-organization selection are verified.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.organizations
  add column kind text not null default 'union'
  constraint organizations_kind_check check (kind in ('union', 'platform'));
create unique index organizations_one_platform on public.organizations (kind) where kind = 'platform';
comment on column public.organizations.kind is
  'union: ordinary tenant; platform: the one internal Union Ground organization, never union discovery or public content. Only service-role/operator SQL can classify it.';

create function private.organization_is_union(p_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists (select 1 from public.organizations o where o.id = p_organization_id and o.kind = 'union');
$function$;
revoke all on function private.organization_is_union(uuid) from public, anon, authenticated, service_role;
grant execute on function private.organization_is_union(uuid) to authenticated, service_role;

create function private.chapter_belongs_to_union(p_chapter_id text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists (select 1 from public.chapters c join public.organizations o on o.id = c.organization_id
    where c.id = p_chapter_id and o.kind = 'union');
$function$;
revoke all on function private.chapter_belongs_to_union(text) from public, anon, authenticated, service_role;
grant execute on function private.chapter_belongs_to_union(text) to authenticated, service_role;

-- True only for a chapter the platform organization owns. A legacy chapter
-- with no owning organization is not platform, so the binding boundary keeps
-- it (20261027050000 preserves such handshake targets; #5813 round 10).
create function private.chapter_belongs_to_platform(p_chapter_id text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists (select 1 from public.chapters c join public.organizations o on o.id = c.organization_id
    where c.id = p_chapter_id and o.kind = 'platform');
$function$;
revoke all on function private.chapter_belongs_to_platform(text) from public, anon, authenticated, service_role;
grant execute on function private.chapter_belongs_to_platform(text) to authenticated, service_role;

-- The one kind predicate the results boundaries share. A missing or null
-- organization is not the platform, so legacy rows without an owner keep
-- their ordinary behavior; internal only, called from definer readers.
create function private.organization_is_platform(p_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists (select 1 from public.organizations o where o.id = p_organization_id and o.kind = 'platform');
$function$;
revoke all on function private.organization_is_platform(uuid) from public, anon, authenticated, service_role;

create function private.enforce_organization_kind()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if (tg_op = 'INSERT' and new.kind <> 'union')
     or (tg_op = 'UPDATE' and new.kind is distinct from old.kind) then
    -- current_user alone would accept authenticated SECURITY DEFINER callers.
    -- The SET ROLE boundary retains the original API role inside those calls.
    if current_setting('role', true) <> 'service_role'
       and not (current_setting('role', true) in ('none', 'postgres', 'supabase_admin')
                and session_user in ('postgres', 'supabase_admin')) then
      raise exception 'service role required to classify an organization' using errcode = '42501';
    end if;
    if new.kind = 'platform' and (
      exists (select 1 from private.organization_claims c where c.organization_id = new.id or c.vouching_organization_id = new.id)
      or exists (select 1 from private.organization_catalog_placements p where p.organization_id = new.id)
      or exists (select 1 from public.chapter_union_org_bindings b join public.chapters c on c.id = b.chapter_id where c.organization_id = new.id)
      or exists (select 1 from public.chapter_handshakes h join public.chapters c on c.id in (h.chapter_id, h.receiving_chapter_id) where c.organization_id = new.id)
      or exists (select 1 from public.organization_network_permission_grants g where new.id in (g.grantor_organization_id, g.grantee_organization_id))
      or exists (select 1 from public.organization_coordination_records r where r.organization_id = new.id)
      or exists (select 1 from public.organization_coordination_organization_participants p where p.organization_id = new.id)
    ) then
      raise exception 'platform designation requires no union bindings or coordination history' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$function$;
revoke all on function private.enforce_organization_kind() from public, anon, authenticated, service_role;
create trigger b10_organization_kind before insert or update on public.organizations
for each row execute function private.enforce_organization_kind();

-- Existing statement case-graph locks serialize designation and these writes.
-- The row guard covers service RPCs too; RLS alone cannot guard a definer.
create function private.enforce_platform_organization_boundary()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare row_data jsonb := to_jsonb(new); subject uuid; chapter text; attribution text;
begin
  -- Auth deletion may only detach one actual ON DELETE SET NULL attribution
  -- FK, nested beneath the deletion of that exact user. Direct edits, content
  -- changes and publication changes still pass through the platform guard.
  if tg_op = 'UPDATE' then
    for attribution in
      select a.attname from pg_catalog.pg_constraint fk
      join pg_catalog.pg_attribute a on a.attrelid = fk.conrelid and a.attnum = fk.conkey[1]
      where fk.conrelid = tg_relid and fk.contype = 'f' and fk.confdeltype = 'n'
        and fk.confrelid = 'auth.users'::regclass and pg_catalog.cardinality(fk.conkey) = 1
    loop
      if row_data - attribution = to_jsonb(old) - attribution
         and private.account_lifecycle_is_nested_auth_detachment(
           (to_jsonb(old) ->> attribution)::uuid, (row_data ->> attribution)::uuid) then
        return new;
      end if;
    end loop;
  end if;
  if tg_table_name in ('public_site_records', 'public_chapter_sections', 'public_chapter_pages')
     and not (row_data ->> 'is_published')::boolean then return new; end if;
  if tg_table_name = 'organization_network_directory_profiles'
     and row_data ->> 'visibility' = 'private' and row_data ->> 'parent_organization_id' is null then return new; end if;
  if tg_table_name = 'chapter_connection_profiles' and row_data ->> 'publication_status' <> 'published' then return new; end if;
  for subject in
    select distinct value::uuid from jsonb_each_text(row_data)
    where key in ('organization_id', 'source_organization_id', 'target_organization_id',
      'requesting_organization_id', 'receiving_organization_id', 'from_organization_id',
      'to_organization_id', 'grantor_organization_id', 'grantee_organization_id',
      'vouching_organization_id', 'parent_organization_id') and value is not null
  loop
    if not private.organization_is_union(subject) then
      raise exception 'platform organization is private' using errcode = '42501';
    end if;
  end loop;
  for chapter in
    select value from jsonb_each_text(row_data)
    where key in ('chapter_id', 'source_chapter_id', 'target_chapter_id',
      'requesting_chapter_id', 'receiving_chapter_id', 'from_chapter_id', 'to_chapter_id')
      and value is not null
  loop
    if exists (select 1 from public.chapters c join public.organizations o on o.id = c.organization_id
      where c.id = chapter and o.kind = 'platform') then
      raise exception 'platform organization is private' using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$function$;
revoke all on function private.enforce_platform_organization_boundary() from public, anon, authenticated, service_role;

create trigger b15_platform_organization_boundary before insert or update on public.public_site_records
for each row execute function private.enforce_platform_organization_boundary();

create trigger b15_platform_organization_boundary before insert or update on public.public_chapter_sections
for each row execute function private.enforce_platform_organization_boundary();

create trigger b15_platform_organization_boundary before insert or update on public.public_chapter_pages
for each row execute function private.enforce_platform_organization_boundary();

create trigger b15_platform_organization_boundary before insert or update on public.organization_network_directory_profiles
for each row execute function private.enforce_platform_organization_boundary();

create trigger b15_platform_organization_boundary before insert or update on private.chapter_connection_profiles
for each row execute function private.enforce_platform_organization_boundary();

create trigger b15_platform_organization_boundary before insert or update on private.organization_claims
for each row execute function private.enforce_platform_organization_boundary();

create trigger b15_platform_organization_boundary before insert or update on private.organization_catalog_placements
for each row execute function private.enforce_platform_organization_boundary();

create trigger b15_platform_organization_boundary before insert or update on public.chapter_union_org_bindings
for each row execute function private.enforce_platform_organization_boundary();

create trigger b15_platform_organization_boundary before insert or update on public.chapter_handshakes
for each row execute function private.enforce_platform_organization_boundary();

create trigger b15_platform_organization_boundary before insert or update on public.organization_network_permission_grants
for each row execute function private.enforce_platform_organization_boundary();

create trigger b15_platform_organization_boundary before insert or update on public.organization_coordination_records
for each row execute function private.enforce_platform_organization_boundary();

create trigger b15_platform_organization_boundary before insert or update on public.organization_coordination_organization_participants
for each row execute function private.enforce_platform_organization_boundary();


-- Re-emitted from 20260930040200_self_serve_organization_shell.sql; only the platform boundary changes.
create or replace function private.organization_clears_signup_boundary(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_organization_id is not null and exists (
    select 1 from public.organizations o
    where o.id = p_organization_id and o.kind = 'union'
      and (o.self_serve_created_at is null
           or o.verified_at is not null
           or private.organization_is_verified(o.id)));
$function$;



-- Keep the reviewed signup boundary, allowing only genuine Auth FK detachment
-- on the two retained publication surfaces. All other checks remain unchanged.
create or replace function private.enforce_unverified_organization_boundary()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  row_data jsonb;
  subject_org uuid;
  other_org uuid;
  attribution text;
begin
  row_data := pg_catalog.to_jsonb(new);

  -- Auth deletion may only detach one actual ON DELETE SET NULL attribution
  -- FK, nested beneath the deletion of that exact user. Direct edits, content
  -- changes and publication changes still pass through the platform guard.
  if tg_op = 'UPDATE' and tg_table_schema = 'public'
     and tg_table_name in ('public_site_records', 'organization_network_directory_profiles') then
    for attribution in
      select a.attname from pg_catalog.pg_constraint fk
      join pg_catalog.pg_attribute a on a.attrelid = fk.conrelid and a.attnum = fk.conkey[1]
      where fk.conrelid = tg_relid and fk.contype = 'f' and fk.confdeltype = 'n'
        and fk.confrelid = 'auth.users'::regclass and pg_catalog.cardinality(fk.conkey) = 1
    loop
      if row_data - attribution = to_jsonb(old) - attribution
         and private.account_lifecycle_is_nested_auth_detachment(
           (to_jsonb(old) ->> attribution)::uuid, (row_data ->> attribution)::uuid) then
        return new;
      end if;
    end loop;
  end if;


  case tg_table_schema || '.' || tg_table_name
    when 'public.chapter_union_org_bindings' then
      select c.organization_id into subject_org
      from public.chapters c where c.id = row_data ->> 'chapter_id';
      if subject_org is not null and not private.organization_clears_signup_boundary(subject_org) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.chapter_handshakes' then
      select c.organization_id into subject_org
      from public.chapters c where c.id = row_data ->> 'chapter_id';
      select c.organization_id into other_org
      from public.chapters c where c.id = row_data ->> 'receiving_chapter_id';
      if (subject_org is not null and not private.organization_clears_signup_boundary(subject_org))
         or (other_org is not null and not private.organization_clears_signup_boundary(other_org)) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;
      -- A later insert trigger stamps the requesting chapter from the
      -- caller's session, so the caller's own organization is checked too.
      if tg_op = 'INSERT' then
        subject_org := private.current_member_organization();
        if subject_org is not null and not private.organization_clears_signup_boundary(subject_org) then
          raise exception 'organization verification required' using errcode = '42501';
        end if;
      end if;

    when 'public.organization_coordination_records' then
      subject_org := (row_data ->> 'organization_id')::uuid;
      other_org := (row_data ->> 'partner_organization_id')::uuid;
      if other_org is not null
         and (not private.organization_clears_signup_boundary(subject_org)
              or not private.organization_clears_signup_boundary(other_org)) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.organization_coordination_organization_participants' then
      other_org := (row_data ->> 'organization_id')::uuid;
      select r.organization_id into subject_org
      from public.organization_coordination_records r
      where r.id = (row_data ->> 'record_id')::uuid;
      -- The owning organization's own participant row stays inside its walls.
      if other_org is distinct from subject_org
         and (not private.organization_clears_signup_boundary(subject_org)
              or not private.organization_clears_signup_boundary(other_org)) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.organization_network_permission_grants' then
      if not private.organization_clears_signup_boundary((row_data ->> 'grantor_organization_id')::uuid)
         or not private.organization_clears_signup_boundary((row_data ->> 'grantee_organization_id')::uuid) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.organization_network_directory_profiles' then
      if not private.organization_clears_signup_boundary((row_data ->> 'organization_id')::uuid)
         and (row_data ->> 'visibility' is distinct from 'private'
              or row_data ->> 'parent_organization_id' is not null) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.public_site_records' then
      subject_org := (row_data ->> 'organization_id')::uuid;
      if subject_org is not null and not private.organization_clears_signup_boundary(subject_org) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'private.dues_stripe_oauth_states', 'public.dues_provider_connections' then
      if not private.organization_clears_signup_boundary((row_data ->> 'organization_id')::uuid) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.member_invitations' then
      select c.organization_id into subject_org
      from public.chapters c where c.id = row_data ->> 'chapter_id';
      -- The a00_case_graph_lock statement trigger already holds the case-graph
      -- lock for this statement, so concurrent invitations count serially.
      if subject_org is not null and not private.organization_clears_signup_boundary(subject_org) then
        if (select pg_catalog.count(*)
              from public.member_invitations i
              join public.chapters c on c.id = i.chapter_id
             where c.organization_id = subject_org
               and i.created_at > pg_catalog.now() - interval '24 hours') >= 20
           or (select pg_catalog.count(*)
                 from public.member_invitations i
                 join public.chapters c on c.id = i.chapter_id
                where c.organization_id = subject_org) >= 200 then
          raise exception 'invitation rate limited' using errcode = 'P0001';
        end if;
      end if;

    when 'private.chapter_connection_profiles' then
      -- A draft stays inside the organization; a published profile reaches
      -- every other organization's staff.
      if row_data ->> 'publication_status' = 'published'
         and not private.organization_clears_signup_boundary((row_data ->> 'organization_id')::uuid) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'private.chapter_connection_hides' then
      -- A hide names another organization's published chapter and is
      -- reciprocal, so it changes what that chapter sees.
      if not private.organization_clears_signup_boundary((row_data ->> 'organization_id')::uuid) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    else
      raise exception 'organization boundary not configured' using errcode = '55000';
  end case;

  return new;
end;
$function$;

-- The entitled member Home cards use the same tenant exclusion as public reads.
create or replace function public.get_reward_cross_chapter_cards(p_locale text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  wanted_locale text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not private.member_reward_effect_enabled(caller, 'cross-chapter-cards') then
    return '[]'::jsonb;
  end if;
  select case
    when p_locale = 'es' or (p_locale is null and p.language = 'es') then 'es'
    else 'en'
  end into wanted_locale
  from public.member_profiles p where p.id = caller;

  return coalesce((
    select pg_catalog.jsonb_agg(card.item order by card.sort_order, card.published_at desc, card.id)
    from (
      select r.id, r.sort_order, r.published_at,
        pg_catalog.jsonb_build_object(
          'id', r.id,
          'title', case when wanted_locale = 'es' then r.title_es else r.title_en end,
          'body', case when wanted_locale = 'es' then r.body_es else r.body_en end,
          'region', case when wanted_locale = 'es' then r.region_es else r.region_en end,
          'url', r.url
        ) as item
      from public.public_site_records r
      where r.is_published and r.kind = 'chapter'
        and not private.organization_is_platform(r.organization_id)
      order by r.sort_order, r.published_at desc, r.id
      limit 12
    ) card
  ), '[]'::jsonb);
end;
$$;

-- Re-emitted from 20260925620500_public_site_content_organization_quarantine.sql; only the platform boundary changes.
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
          and private.organization_visible_in_directory(r.organization_id)
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


-- Re-emitted from 20260924150200_public_directory_upcoming_events_window.sql; only the platform boundary changes.
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
          and private.organization_visible_in_directory(r.organization_id)
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


-- Re-emitted from 20260822020000_mi1_w1_feature_persistence.sql; only the platform boundary changes.
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
    'category', 'meeting'
  ) into result
  from public.public_site_records r
  where r.id = p_event_id
    and r.is_published
    and r.kind = 'meeting'
    and r.organization_id is not null
          and private.organization_visible_in_directory(r.organization_id)
          and private.organization_is_union(r.organization_id);
  return result;
end;
$function$;


-- Re-emitted from 20260925220000_public_event_rsvp_ended_meeting_gate.sql; only the platform boundary changes.
create or replace function public.submit_public_event_rsvp(
  p_event_id text, p_email text, p_name text, p_locale text,
  p_source text, p_website text, p_scope_hash text, p_email_scope_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  event_org uuid;
  normalized_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  normalized_name text := nullif(pg_catalog.btrim(coalesce(p_name, '')), '');
  event_scope_hash text;
  moment timestamptz := clock_timestamp();
  network_allowed boolean;
  email_allowed boolean := false;
  event_allowed boolean := false;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if pg_catalog.btrim(coalesce(p_website, '')) <> '' then return pg_catalog.jsonb_build_object('accepted', true); end if;
  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_email_scope_hash is null or p_email_scope_hash !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('accepted', true);
  end if;
  if pg_catalog.char_length(coalesce(p_event_id, '')) not between 1 and 128
     or pg_catalog.char_length(normalized_email) not between 3 and 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or (normalized_name is not null and pg_catalog.char_length(normalized_name) > 100)
     or p_source is distinct from 'public-event-rsvp'
     or p_locale is null or p_locale not in ('en', 'es') then
    return pg_catalog.jsonb_build_object('accepted', true);
  end if;
  network_allowed := private.consume_public_event_rsvp_limit(p_scope_hash, 'network-15m', 20, interval '15 minutes');
  if network_allowed then
    select r.organization_id into event_org from public.public_site_records r
    where r.id = p_event_id and r.is_published and r.kind = 'meeting' and r.organization_id is not null
      and coalesce(r.ends_at, r.starts_at) >= now()
      and private.organization_visible_in_directory(r.organization_id)
      and private.organization_is_union(r.organization_id);
  end if;
  if network_allowed and event_org is not null then
    email_allowed := private.consume_public_event_rsvp_limit(
      p_email_scope_hash, 'email-event-day', 3, interval '1 day'
    );
  end if;
  if network_allowed and email_allowed then
    event_scope_hash := pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(event_org::text || ':' || p_event_id, 'UTF8'), 'sha256'), 'hex'
    );
    event_allowed := private.consume_public_event_rsvp_limit(event_scope_hash, 'event-day', 500, interval '1 day');
  end if;
  if network_allowed and email_allowed and event_allowed then
    insert into public.public_event_rsvps (organization_id, event_id, email, name, locale)
    values (event_org, p_event_id, normalized_email, normalized_name, p_locale)
    on conflict (event_id, email) do nothing;
  end if;
  delete from private.public_event_rsvp_limits as stale
  where stale.ctid in (
    select candidate.ctid from private.public_event_rsvp_limits as candidate
    where candidate.window_started_at < moment - interval '2 days'
      and candidate.scope_hash <> all(pg_catalog.array_remove(
        array[p_scope_hash, p_email_scope_hash, event_scope_hash]::text[], null
      ))
    order by candidate.window_started_at limit 200 for update skip locked
  );
  return pg_catalog.jsonb_build_object('accepted', true);
end;
end;
$function$;


-- Re-emitted from 20260924150000_public_chapter_microsite_upcoming_events.sql; only the platform boundary changes.
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
          and private.organization_visible_in_directory(record.organization_id)
          and private.organization_is_union(record.organization_id);
  return chapter;
end;
$function$;


-- Re-emitted from 20260930040000_union_catalog_claims_verification.sql; only the platform boundary changes.
create or replace function public.get_organization_public_verification(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  organization public.organizations%rowtype;
  placement private.organization_catalog_placements%rowtype;
  identity jsonb;
  parent jsonb;
begin
  if p_slug is null or p_slug !~ '^[a-z0-9][a-z0-9-]{0,63}$' then
    return pg_catalog.jsonb_build_object('found', false);
  end if;
  select * into organization
    from public.organizations as o
   where o.slug = p_slug
     and o.status = 'active'
     and private.organization_visible_in_directory(o.id)
     and o.kind = 'union';
  if not found then
    return pg_catalog.jsonb_build_object('found', false);
  end if;

  select * into placement
    from private.organization_catalog_placements as p
   where p.organization_id = organization.id;
  if found and placement.verified_at is not null
     and (placement.identity_catalog_key is null or exists (select 1 from private.catalog_organizations o
       where o.catalog_key = placement.identity_catalog_key and private.catalog_registry_identity_visible(o.union_org_id))) then
    identity := case
      when placement.identity_catalog_key is not null then pg_catalog.jsonb_build_object(
        'kind', 'catalog',
        'catalogKey', placement.identity_catalog_key,
        'name', (select o.name from private.catalog_organizations as o
                  where o.catalog_key = placement.identity_catalog_key))
      else pg_catalog.jsonb_build_object('kind', 'unlisted') end;
  end if;
  if found and placement.parent_catalog_key is not null
     and exists (select 1 from private.catalog_organizations o where o.catalog_key = placement.parent_catalog_key
       and private.catalog_registry_identity_visible(o.union_org_id)) then
    parent := pg_catalog.jsonb_build_object(
      'kind', 'catalog',
      'catalogKey', placement.parent_catalog_key,
      'name', (select o.name from private.catalog_organizations as o
                where o.catalog_key = placement.parent_catalog_key),
      'selfReported', true);
  elsif found and placement.unlisted_parent_name is not null then
    parent := pg_catalog.jsonb_build_object('kind', 'unlisted', 'selfReported', true);
  end if;

  return pg_catalog.jsonb_build_object(
    'found', true,
    'organization', pg_catalog.jsonb_build_object('name', organization.name, 'slug', organization.slug),
    'verification', pg_catalog.jsonb_build_object(
      'status', case when identity is not null then 'verified' else 'self_reported' end,
      'identity', identity,
      'verifiedOn', case when identity is not null then (placement.verified_at at time zone 'America/New_York')::date end),
    'placement', parent
  );
end;
$function$;


-- Re-emitted from 20260930040200_self_serve_organization_shell.sql; only the platform boundary changes.
create or replace function private.organization_network_can_discover(p_subject_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.organization_is_union(p_subject_organization_id)
    and private.organization_is_union(private.current_member_organization())
    and private.current_member_organization() is not null
    and (
      p_subject_organization_id = (select private.current_member_organization())
      or (
        private.organization_clears_signup_boundary((select private.current_member_organization()))
        and private.organization_visible_in_directory(p_subject_organization_id)
        and (
          exists (
            select 1
            from public.organization_network_directory_profiles p
            where p.organization_id = p_subject_organization_id
              and p.visibility = 'directory'
          )
          or private.organization_network_has_permission(
            (select private.current_member_organization()),
            p_subject_organization_id,
            'directory_contact'
          )
        )
      )
    );
$function$;


-- Re-emitted from 20260828232000_mi1_organization_coordination_workflows.sql; only the platform boundary changes.
create or replace function private.organization_network_has_permission(
  p_first_organization_id uuid,
  p_second_organization_id uuid,
  p_capability text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.organization_is_union(p_first_organization_id)
    and private.organization_is_union(p_second_organization_id)
    and p_second_organization_id is not null
    and exists (
      select 1
      from public.organization_network_permission_grants g
      join public.organization_coordination_records r
        on r.id = g.network_record_id
      where g.status = 'active'
        and g.capability = p_capability
        and r.kind = 'network_link'
        and r.status = 'active'
        and (
          (g.grantor_organization_id = p_first_organization_id
            and g.grantee_organization_id = p_second_organization_id)
          or (g.grantor_organization_id = p_second_organization_id
            and g.grantee_organization_id = p_first_organization_id)
        )
    );
$function$;


-- Re-emitted from 20260930040200_self_serve_organization_shell.sql; only the platform boundary changes.
create or replace function public.list_chapter_connection_profiles(
  p_selected_hat text,
  p_after_id text default null,
  p_limit integer default 250,
  p_snapshot_token text default null,
  p_chapter_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  viewer_chapter text;
  cap integer;
  current_epoch bigint;
  token_epoch bigint;
  snapshot_at timestamptz;
  token text;
  scope_hash text;
  after_id text;
  rows_out jsonb;
  fetched integer;
  last_id text;
begin
  org := private.mi1_require_selected_organization();
  viewer_chapter := private.chapter_connection_require_chapter(org, coalesce(nullif(pg_catalog.btrim(p_chapter_id), ''), private.current_member_chapter()));
  perform private.chapter_connection_require_hat(
    org, p_selected_hat, viewer_chapter, array['steward', 'coordinator', 'advisor', 'admin', 'vp']);

  scope_hash := pg_catalog.md5(org::text || ':' || viewer_chapter || ':' || p_selected_hat);

  cap := least(greatest(coalesce(p_limit, 250), 1), 500);
  after_id := nullif(pg_catalog.btrim(coalesce(p_after_id, '')), '');

  select e.epoch into current_epoch from private.chapter_connection_registry_epoch e where e.singleton;
  current_epoch := coalesce(current_epoch, 1);

  if p_snapshot_token is null then
    snapshot_at := pg_catalog.to_timestamp(pg_catalog.floor(extract(epoch from pg_catalog.now()))::double precision);
  else
    if p_snapshot_token !~ '^[0-9]{1,18}:[0-9]{1,12}:[a-f0-9]{32}$' then
      raise exception 'connection registry snapshot token invalid' using errcode = '22023';
    end if;
    token_epoch := pg_catalog.split_part(p_snapshot_token, ':', 1)::bigint;
    snapshot_at := pg_catalog.to_timestamp(pg_catalog.split_part(p_snapshot_token, ':', 2)::double precision);
    if pg_catalog.split_part(p_snapshot_token, ':', 3) <> scope_hash then
      raise exception 'connection registry snapshot scope changed' using errcode = '22023';
    end if;
    if token_epoch <> current_epoch then
      raise exception 'connection registry snapshot changed' using errcode = '22023';
    end if;
    if snapshot_at > pg_catalog.now() + interval '1 minute'
       or snapshot_at < pg_catalog.now() - interval '1 hour' then
      raise exception 'connection registry snapshot expired' using errcode = '22023';
    end if;
  end if;
  token := current_epoch::text || ':' || pg_catalog.floor(extract(epoch from snapshot_at))::bigint::text || ':' || scope_hash;

  select
    coalesce(pg_catalog.jsonb_agg(page.item order by page.chapter_id collate "C"), '[]'::jsonb),
    pg_catalog.count(*)::integer,
    pg_catalog.max(page.chapter_id collate "C")
  into rows_out, fetched, last_id
  from (
    select
      p.chapter_id,
      private.chapter_connection_profile_projection(p, c.name) as item
    from private.chapter_connection_profiles p
    join public.chapters c on c.id = p.chapter_id and c.organization_id = p.organization_id
    join public.organizations o on o.id = p.organization_id and o.status = 'active' and o.kind = 'union'
    where p.publication_status = 'published'
      and (p.organization_id = org or private.organization_visible_in_directory(p.organization_id))
      and p.expires_at > snapshot_at
      and p.chapter_id <> viewer_chapter
      and private.organization_clears_signup_boundary(org)
      and (after_id is null or p.chapter_id collate "C" > after_id collate "C")
      and not exists (
        select 1 from private.chapter_connection_hides h
        where (h.chapter_id = viewer_chapter and h.hidden_chapter_id = p.chapter_id)
           or (h.chapter_id = p.chapter_id and h.hidden_chapter_id = viewer_chapter)
      )
    order by p.chapter_id collate "C"
    limit cap + 1
  ) page;

  if fetched > cap then
    -- Drop the look-ahead row: the page is the first cap rows in order.
    rows_out := (
      select coalesce(pg_catalog.jsonb_agg(elem.value order by elem.ordinality), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(rows_out) with ordinality as elem
      where elem.ordinality <= cap
    );
    last_id := rows_out -> (cap - 1) ->> 'id';
  end if;

  return pg_catalog.jsonb_build_object(
    'snapshotToken', token,
    'snapshotAt', snapshot_at,
    'rows', rows_out,
    'nextCursor', case when fetched > cap then last_id else null end,
    'complete', fetched <= cap
  );
end;
$function$;


-- Re-emitted from 20261003065000_compass_scope_path_resolver.sql; only the platform boundary changes.
create or replace function private.compass_retrieval_scope_summary(p_query text, p_sources jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare org uuid; resolution text; alternatives jsonb; fallback boolean;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'sign in required' using errcode = '42501';
  end if;
  select q.organization_id, q.resolution into org, resolution
    from private.compass_quota_organization((select auth.uid())) q;
  if resolution in ('ambiguous', 'unresolved') then
    raise exception 'organization context required' using errcode = '42501';
  end if;
  select coalesce(pg_catalog.bool_and(source ->> 'scope_level' = 'local'), false) into fallback
    from pg_catalog.jsonb_array_elements(p_sources) source where source ->> 'source_id' like 'kb:%';
  -- A notice may name only another ACTIVE membership's organization. It does
  -- not return its source ids, titles, references, snippets, counts or scores.
  select coalesce(pg_catalog.jsonb_agg(match.organization_id order by match.organization_id), '[]'::jsonb)
    into alternatives from (
      select distinct organization.id as organization_id
      from public.organization_memberships membership
      join public.organizations organization on organization.id = membership.organization_id and organization.status = 'active' and organization.kind = 'union'
      where membership.user_id = (select auth.uid()) and membership.status = 'active'
        and organization.id is distinct from org and org is not null
        and nullif(pg_catalog.btrim(p_query), '') is not null
        and exists (
          select 1 from public.member_kb_articles a
          join public.chapters member_chapter on member_chapter.organization_id = organization.id
          join public.member_chapter_memberships chapter_membership on chapter_membership.chapter_id = member_chapter.id
            and chapter_membership.user_id = (select auth.uid()) and chapter_membership.status = 'active'
          where a.compass_organization_id = organization.id
            and private.compass_article_scope_current(a)
            and not a.is_sample and a.status = 'published' and a.verified_by is not null and a.verified_at is not null
            and private.knowledge_article_content_current(a) and private.compass_article_classification_current(a)
            and (a.compass_scope_level = 'local'
              or (a.compass_scope_level = 'chapter' and a.chapter_id = member_chapter.id)
              or (a.compass_scope_level = 'agency' and a.compass_scope_path =
                (private.compass_scope_path_for_chapter(member_chapter.id))[1:pg_catalog.cardinality(a.compass_scope_path)])
              or (a.compass_scope_level = 'unit' and a.chapter_id = member_chapter.id
                and a.compass_scope_unit_key = any(chapter_membership.compass_unit_keys)
                and chapter_membership.compass_scope_verification is not null))
            and pg_catalog.to_tsvector('english', coalesce(a.title, '') || ' ' || coalesce(a.article_ref, '') || ' ' ||
              coalesce(a.compass_classification ->> 'text', '') || ' ' || pg_catalog.array_to_string(a.keywords, ' '))
              @@ pg_catalog.plainto_tsquery('english', p_query)
        )
      order by organization.id limit 10
    ) match;
  return pg_catalog.jsonb_build_object('version', 'compass-scope-v1', 'organization_id', org,
    'local_fallback', fallback, 'matching_organization_ids', alternatives);
end;
$$;


-- Re-emitted from 20261010200000_ai_usage_digest_privacy_repair.sql; only the platform boundary changes.
create or replace function private.generate_analytics_usage_digests(
  p_now timestamptz default pg_catalog.now(),
  p_limit integer default 200,
  p_force boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  local_now timestamp := coalesce(p_now, pg_catalog.now()) at time zone 'America/New_York';
  org record;
  period text;
  window_row record;
  first_start date;
  last_end date;
  buckets jsonb;
  deltas jsonb;
  bucket jsonb;
  floor_size integer;
  inserted integer := 0;
  added integer;
  org_inserted integer;
  has_data boolean;
begin
  if not coalesce(p_force, false) and pg_catalog.date_part('hour', local_now) < 9 then
    return 0;
  end if;
  delete from private.analytics_usage_digests d
  where not exists (select 1 from public.organizations o where o.id = d.organization_id);
  delete from private.analytics_usage_digest_visits v
  where v.window_start < ((coalesce(p_now, pg_catalog.now()) at time zone 'UTC')::date - 112)
     or not exists (select 1 from public.organizations o where o.id = v.organization_id);

  for org in
    select o.id
    from public.organizations o
    where o.status = 'active' and o.kind = 'union'
      and private.organization_feature_enabled(o.id, 'features.analytics.ai_usage_digest')
      and not exists (
        select 1 from private.analytics_usage_digest_visits v
        where v.organization_id = o.id
          and v.period = 'weekly'
          and v.window_start = (select min(w.bucket_start) from private.usage_digest_windows('weekly', p_now) w)
      )
    order by o.id
    limit greatest(1, least(coalesce(p_limit, 200), 1000))
  loop
    begin
    org_inserted := 0;
    floor_size := greatest(25, coalesce(private.organization_limit(org.id, 'limits.analytics.ai_usage_digest_min_cohort'), 25),
      coalesce(private.organization_limit(org.id, 'limits.analytics.anonymity_floor'), 25));
    foreach period in array array['weekly', 'monthly'] loop
      buckets := '[]'::jsonb;
      deltas := '[]'::jsonb;
      first_start := null;
      last_end := null;
      for window_row in select w.bucket_start, w.bucket_end from private.usage_digest_windows(period, p_now) w order by w.bucket_start loop
        -- An interval stored by an earlier release keeps its first figures
        -- and suppression decision: a recount after account deletion or a
        -- floor change would differ from the published one by exactly what
        -- left the interval, and the difference would be subtractable.
        select b.value into bucket
        from private.analytics_usage_digests d
        cross join lateral pg_catalog.jsonb_array_elements(d.buckets) b
        where d.organization_id = org.id
          and (b.value ->> 'start')::date = window_row.bucket_start
          and (b.value ->> 'end')::date = window_row.bucket_end
        order by d.generated_at, d.id
        limit 1;
        -- Stored under a lower floor than today's: keep it dark rather than
        -- recount it.
        if bucket is not null and coalesce((bucket ->> 'minCohort')::integer, 0) < floor_size then
          bucket := private.usage_digest_withheld_bucket(window_row.bucket_start, window_row.bucket_end, floor_size);
        end if;
        if bucket is null then
          bucket := private.usage_digest_bucket(org.id, window_row.bucket_start, window_row.bucket_end, floor_size);
          -- A bucket that passed its own floors still withholds a figure when
          -- the people it adds beyond its separately publishable inner weeks
          -- are under the floor (project decision Q40 = A; F1 for check-ins).
          if (bucket ->> 'suppressed')::boolean is false
            and not private.usage_digest_window_publishable(org.id, window_row.bucket_start, window_row.bucket_end, floor_size, 'page_view') then
            bucket := private.usage_digest_withheld_bucket(window_row.bucket_start, window_row.bucket_end, floor_size);
          elsif bucket ->> 'checkins' is not null
            and not private.usage_digest_window_publishable(org.id, window_row.bucket_start, window_row.bucket_end, floor_size, 'meeting_check_in') then
            bucket := bucket || pg_catalog.jsonb_build_object('checkins', null);
          end if;
        end if;
        buckets := buckets || pg_catalog.jsonb_build_array(bucket);
        first_start := coalesce(first_start, window_row.bucket_start);
        last_end := window_row.bucket_end;
      end loop;
      insert into private.analytics_usage_digest_visits (organization_id, period, window_start)
      values (org.id, period, first_start)
      on conflict on constraint analytics_usage_digest_visits_pkey do nothing;
      -- The last two buckets are the comparison the old digest reported
      -- (de7df4b57c^:lib/analytics/usage-digest.ts deltas). A withheld figure
      -- on either side reports direction 'unknown' and no figures.
      if pg_catalog.jsonb_array_length(buckets) >= 2 then
        deltas := (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'metric', metric.name,
            'current', current_bucket.value -> metric.name,
            'previous', previous_bucket.value -> metric.name,
            'direction', private.usage_digest_direction(
              (current_bucket.value ->> metric.name)::integer,
              (previous_bucket.value ->> metric.name)::integer)
          ) order by metric.ordinality), '[]'::jsonb)
          from pg_catalog.unnest(array['actors', 'checkins']) with ordinality as metric(name, ordinality)
          cross join lateral (select buckets -> (pg_catalog.jsonb_array_length(buckets) - 1) as value) current_bucket
          cross join lateral (select buckets -> (pg_catalog.jsonb_array_length(buckets) - 2) as value) previous_bucket
        );
      end if;
      has_data := exists (
        select 1 from pg_catalog.jsonb_array_elements(buckets) element
        where (element.value ->> 'suppressed')::boolean is false
          and (element.value ->> 'actors')::integer > 0
      );
      insert into private.analytics_usage_digests (
        organization_id, period, window_start, window_end, buckets, deltas, has_data, ai_status
      ) values (
        org.id, period, first_start, last_end, buckets, deltas,
        has_data,
        case when has_data and private.organization_feature_enabled(org.id, 'features.analytics.ai_usage_digest_wording')
          then 'available' else 'not_requested' end
      )
      on conflict on constraint analytics_usage_digests_one_per_window do nothing;
      get diagnostics added = row_count;
      org_inserted := org_inserted + added;
    end loop;
    inserted := inserted + org_inserted;
    exception when others then
      -- Do not expose SQL error details or hold later organizations behind a
      -- repeatedly failing first row. Retry this organization next window.
      insert into private.analytics_usage_digest_visits (organization_id, period, window_start)
      select org.id, 'weekly', min(w.bucket_start) from private.usage_digest_windows('weekly', p_now) w
      on conflict on constraint analytics_usage_digest_visits_pkey do nothing;
      raise warning 'usage digest organization skipped (SQLSTATE %)', sqlstate;
    end;
  end loop;
  return inserted;
end;
$function$;


-- Re-emitted from 20260930040000_union_catalog_claims_verification.sql; only the platform boundary changes.
create or replace function public.submit_organization_claim(
  p_scope_hash text,
  p_email_scope_hash text,
  p_catalog_key text,
  p_unlisted jsonb,
  p_claimant jsonb,
  p_attestation jsonb,
  p_locale text,
  p_confirm_token_hash text,
  p_requesting_user_id uuid,
  p_organization_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  moment timestamptz;
  clean_claimant_name text;
  clean_claimant_title text;
  clean_claimant_email text;
  clean_claimant_statement text;
  clean_unlisted_name text;
  clean_unlisted_city text;
  clean_unlisted_state text;
  allowed boolean;
  target_normalized text;
  new_claim_id uuid;
begin
  perform private.lock_case_graph(array[p_requesting_user_id], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  moment := clock_timestamp();

  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_email_scope_hash is null or p_email_scope_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid rate scope' using errcode = '22023';
  end if;
  if p_confirm_token_hash is null or p_confirm_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid confirmation token' using errcode = '22023';
  end if;
  if p_locale is null or p_locale not in ('en', 'es') then
    raise exception 'invalid locale' using errcode = '22023';
  end if;
  if p_attestation is null or p_attestation is distinct from
       '{"version":"claim-attest/1","officer":true,"verifyFirst":true,"noPersonalData":true,"notEmployer":true}'::jsonb then
    raise exception 'attestation required' using errcode = '22023';
  end if;

  -- Exactly one target: a catalog key, or an unlisted organization.
  if pg_catalog.num_nonnulls(p_catalog_key, p_unlisted) <> 1 then
    raise exception 'claim target invalid' using errcode = '22023';
  end if;
  if p_catalog_key is not null and p_catalog_key !~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$' then
    raise exception 'claim target invalid' using errcode = '22023';
  end if;
  if p_unlisted is not null then
    if pg_catalog.jsonb_typeof(p_unlisted) is distinct from 'object'
       or p_unlisted - array['name', 'city', 'state'] <> '{}'::jsonb
       or pg_catalog.jsonb_typeof(p_unlisted -> 'name') is distinct from 'string'
       or (p_unlisted ? 'city' and pg_catalog.jsonb_typeof(p_unlisted -> 'city') not in ('string', 'null'))
       or (p_unlisted ? 'state' and pg_catalog.jsonb_typeof(p_unlisted -> 'state') not in ('string', 'null')) then
      raise exception 'claim target invalid' using errcode = '22023';
    end if;
    clean_unlisted_name := pg_catalog.btrim(p_unlisted ->> 'name');
    clean_unlisted_city := nullif(pg_catalog.btrim(coalesce(p_unlisted ->> 'city', '')), '');
    clean_unlisted_state := nullif(pg_catalog.btrim(coalesce(p_unlisted ->> 'state', '')), '');
    -- The unlisted name is shown to a vouching organization's admins, so it
    -- gets 4a's placement-name filter: no email, link or phone number.
    if pg_catalog.char_length(clean_unlisted_name) not between 3 and 200
       or clean_unlisted_name ~ '[[:cntrl:]]'
       or clean_unlisted_name !~ '[[:alnum:]]'
       or pg_catalog.strpos(clean_unlisted_name, '@') > 0
       or pg_catalog.strpos(clean_unlisted_name, '://') > 0
       or pg_catalog.regexp_replace(clean_unlisted_name, '[[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]', '', 'g') ~ '[[:digit:]]{7,}'
       or (clean_unlisted_city is not null and (pg_catalog.char_length(clean_unlisted_city) > 120 or clean_unlisted_city ~ '[[:cntrl:]]'
           or pg_catalog.strpos(clean_unlisted_city, '@') > 0
           or pg_catalog.strpos(clean_unlisted_city, '://') > 0
           or pg_catalog.regexp_replace(clean_unlisted_city, '[[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]', '', 'g') ~ '[[:digit:]]{7,}'))
       or (clean_unlisted_state is not null and clean_unlisted_state !~ '^[A-Z]{2}$') then
      raise exception 'claim target invalid' using errcode = '22023';
    end if;
  end if;

  -- The claimant: exactly name, title, email and statement, all strings.
  if pg_catalog.jsonb_typeof(p_claimant) is distinct from 'object'
     or (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(p_claimant) as k)
          is distinct from array['email', 'name', 'statement', 'title']
     or pg_catalog.jsonb_typeof(p_claimant -> 'name') <> 'string'
     or pg_catalog.jsonb_typeof(p_claimant -> 'title') <> 'string'
     or pg_catalog.jsonb_typeof(p_claimant -> 'email') <> 'string'
     or pg_catalog.jsonb_typeof(p_claimant -> 'statement') <> 'string' then
    raise exception 'claimant invalid' using errcode = '22023';
  end if;
  clean_claimant_name := pg_catalog.btrim(p_claimant ->> 'name');
  clean_claimant_title := pg_catalog.btrim(p_claimant ->> 'title');
  clean_claimant_email := pg_catalog.btrim(p_claimant ->> 'email');
  clean_claimant_statement := nullif(pg_catalog.btrim(p_claimant ->> 'statement'), '');
  if pg_catalog.char_length(clean_claimant_name) not between 2 and 120 or clean_claimant_name ~ '[[:cntrl:]]'
     or pg_catalog.char_length(clean_claimant_title) not between 1 and 120 or clean_claimant_title ~ '[[:cntrl:]]'
     or pg_catalog.char_length(clean_claimant_email) not between 3 and 254
     or clean_claimant_email <> pg_catalog.lower(clean_claimant_email)
     or clean_claimant_email !~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$'
     or pg_catalog.char_length(coalesce(clean_claimant_statement, '')) > 1000 then
    raise exception 'claimant invalid' using errcode = '22023';
  end if;

  -- The requesting admin of an existing organization (organizations are
  -- created at signup, never by a claim).
  if p_requesting_user_id is null or p_organization_id is null then
    raise exception 'claim requester invalid' using errcode = '22023';
  end if;
  if not exists (
       select 1 from public.organizations as o
        where o.id = p_organization_id and o.status = 'active' and o.kind = 'union')
     or not exists (
       select 1 from public.organization_memberships as m
        where m.organization_id = p_organization_id
          and m.user_id = p_requesting_user_id
          and m.status = 'active')
     or not exists (
       select 1 from public.organization_role_grants as g
        where g.organization_id = p_organization_id
          and g.user_id = p_requesting_user_id
          and g.role = 'admin') then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Limits, then silent refusals. Every refusal answers exactly like success.
  allowed := private.consume_public_interest_submission_limit(
    p_scope_hash, 'claim-network-hour', 5, interval '1 hour');
  if allowed then
    allowed := private.consume_public_interest_submission_limit(
      p_email_scope_hash, 'claim-email-day', 3, interval '1 day');
  end if;
  if allowed then
    allowed := private.consume_public_interest_submission_limit(
      pg_catalog.encode(extensions.digest('organization-claim-org:' || p_organization_id::text, 'sha256'), 'hex'),
      'claim-org-day', 3, interval '1 day');
  end if;

  if allowed then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('union-catalog-claim-target:' || coalesce(p_catalog_key, 'unlisted'), 509));
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('union-catalog-claim-org:' || p_organization_id::text, 509));

    target_normalized := coalesce(p_catalog_key, 'unlisted:' || pg_catalog.lower(clean_unlisted_name));

    -- A claim whose confirmation deadline has passed is lapsed even before the
    -- daily sweep runs: expire it here, exactly as the sweep would, so it never
    -- blocks this organization or this listing.
    with lapsed as (
      update private.organization_claims as c
         set status = 'expired',
             confirm_token_hash = null,
             closed_at = pg_catalog.now(),
             updated_at = pg_catalog.now()
       where c.status = 'awaiting_email'
         and c.confirm_expires_at <= pg_catalog.now()
         and (c.organization_id = p_organization_id
              or coalesce(c.catalog_key, 'unlisted:' || pg_catalog.lower(pg_catalog.btrim(c.unlisted_name))) = target_normalized)
      returning c.id, c.organization_id, c.catalog_key
    )
    insert into private.catalog_review_events (
      event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
    )
    select 'claim_expired', 'system', null, 'claim', lapsed.id, lapsed.organization_id,
           pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
             'catalogKey', lapsed.catalog_key, 'fromStatus', 'awaiting_email', 'toStatus', 'expired')),
           extensions.gen_random_uuid()
      from lapsed;

    if p_catalog_key is not null and not exists (
         select 1 from private.catalog_organizations as o
          where o.catalog_key = p_catalog_key
            and o.retired_release_id is null
            and o.duplicate_of is null
            and (private.catalog_registry_identity_visible(o.union_org_id)
              or private.organization_owns_fictional_registry(p_organization_id, o.union_org_id))) then
      allowed := false;
    elsif (select pg_catalog.count(*)
             from private.organization_claims as c
            where coalesce(c.catalog_key, 'unlisted:' || pg_catalog.lower(pg_catalog.btrim(c.unlisted_name))) = target_normalized
              and c.status in ('awaiting_email', 'under_review', 'held')) >= 20 then
      allowed := false;
    elsif exists (
         select 1 from private.organization_claims as c
          where c.claimant_email_scope = p_email_scope_hash
            and coalesce(c.catalog_key, 'unlisted:' || pg_catalog.lower(pg_catalog.btrim(c.unlisted_name))) = target_normalized
            and c.status in ('awaiting_email', 'under_review', 'held')) then
      allowed := false;
    elsif exists (
         select 1 from private.organization_claims as c
          where c.organization_id = p_organization_id
            and c.status in ('awaiting_email', 'under_review', 'held')) then
      allowed := false;
    elsif private.organization_is_verified(p_organization_id) then
      allowed := false;
    elsif exists (
         select 1 from private.public_interest_suppressions as suppression
          where suppression.suppression_scope_hash = private.public_interest_suppression_scope(clean_claimant_email)) then
      allowed := false;
    end if;
  end if;

  if allowed then
    insert into private.organization_claims (
      catalog_key, unlisted_name, unlisted_city, unlisted_state,
      organization_id, claimant_user_id,
      claimant_name, claimant_title, claimant_email, statement, claimant_email_scope,
      locale, attestation_version, attested_at, confirm_token_hash, confirm_expires_at, status
    ) values (
      p_catalog_key, clean_unlisted_name, clean_unlisted_city, clean_unlisted_state,
      p_organization_id, p_requesting_user_id,
      clean_claimant_name, clean_claimant_title, clean_claimant_email, clean_claimant_statement, p_email_scope_hash,
      p_locale, 'claim-attest/1', pg_catalog.now(), p_confirm_token_hash, pg_catalog.now() + interval '24 hours',
      'awaiting_email'
    )
    returning id into new_claim_id;

    insert into private.catalog_review_events (
      event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
    ) values (
      'claim_submitted', 'organization_admin',
      p_requesting_user_id, 'claim', new_claim_id, p_organization_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'catalogKey', p_catalog_key, 'toStatus', 'awaiting_email')),
      extensions.gen_random_uuid()
    );

    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      p_organization_id, 'administration', 'organization_catalog_verification_requested', 'create',
      p_requesting_user_id, 'organization', p_organization_id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object(
        'organizationId', p_organization_id,
        'entityType', 'catalog_organization',
        'entityId', coalesce(p_catalog_key, 'unlisted'),
        'toStatus', 'awaiting_email'
      )
    );
  end if;

  delete from private.public_interest_submission_limits as stale
  where stale.ctid in (
    select candidate.ctid
    from private.public_interest_submission_limits as candidate
    where candidate.window_started_at < moment - interval '2 days'
      and candidate.scope_hash not in (p_scope_hash, p_email_scope_hash)
    order by candidate.window_started_at
    limit 200
    for update skip locked
  );

  return pg_catalog.jsonb_build_object('accepted', true, 'deliver', allowed);
end;
$function$;


-- Re-emitted from 20261018022908_concurrent_lifecycle_read_admission.sql; only the platform boundary changes.
create or replace function public.get_organization_analytics_snapshot()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph_read();
  perform private.member_pin_require_full_session();
  if not private.organization_is_union(private.mi1_require_selected_organization()) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
declare
  org uuid := private.mi1_require_selected_organization();
  generated timestamptz := pg_catalog.now();
  period_end timestamptz := pg_catalog.date_trunc('month', generated);
  period_start timestamptz := pg_catalog.date_trunc('month', generated) - interval '6 months';
  privacy_threshold integer := private.organization_limit(org, 'limits.analytics.anonymity_floor');
  attendance_start timestamptz := generated - interval '180 days';
  result jsonb;
  snapshot_id uuid := extensions.gen_random_uuid();
  published_rows integer;
  withheld_rows integer;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  result := pg_catalog.jsonb_build_object(
    'organizationId', org,
    'generatedAt', generated,
    'privacyThreshold', privacy_threshold,
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'label', c.name,
        'memberCount', case when member_totals.value >= privacy_threshold
          then (pg_catalog.floor(member_totals.value / 5.0) * 5)::integer else null end,
        'memberCountSuppressed', member_totals.value < privacy_threshold,
        'stewardCount', case when steward_totals.value >= privacy_threshold
          and member_totals.value - steward_totals.value >= privacy_threshold
          then (pg_catalog.floor(steward_totals.value / 5.0) * 5)::integer else null end,
        'stewardCountSuppressed', steward_totals.value < privacy_threshold
          or member_totals.value - steward_totals.value < privacy_threshold
      ) order by c.name, c.id)
      from public.chapters c
      cross join lateral (
        select pg_catalog.count(*) as value from public.member_chapter_memberships m
        where m.chapter_id = c.id and m.status = 'active'
      ) member_totals
      cross join lateral (
        select pg_catalog.count(distinct rc.user_id) as value
        from public.member_role_chapters rc
        join public.member_chapter_memberships m
          on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id and m.status = 'active'
        where rc.chapter_id = c.id and rc.role = 'steward'
      ) steward_totals
      where c.organization_id = org
    ), '[]'::jsonb),
    'cases', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'chapterId', counted.chapter_id, 'status', counted.status,
        'step', counted.step_bucket, 'workplaceKey', counted.case_type,
        'count', (pg_catalog.floor(counted.person_count / 5.0) * 5)::integer
      ) order by counted.chapter_id, counted.status, counted.case_type, counted.step_bucket)
      from (
        select cs.chapter_id, cs.status,
          case when cs.step in ('Intake', 'intake') then 0 else 2 end as step_bucket,
          cs.case_type, pg_catalog.count(distinct cs.user_id) as person_count
        from public.member_cases cs
        where cs.organization_id = org and cs.chapter_id is not null
          and cs.created_at >= period_start and cs.created_at < period_end
        group by cs.chapter_id, cs.status, step_bucket, cs.case_type
        having pg_catalog.count(distinct cs.user_id) >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    -- OPS-UG-ANALYTICS-READ-SIDE-SHIPPED-BUT-NOTHING-IN-PRODUCTION-WRITES-ORGANIZATION-ENGAGEMENT-EVENTS-20260921
    -- (project decision 2026-09-25, AUTHENTICATED PAGE-VIEW PRODUCER):
    -- public.record_workspace_page_view fills organization_page_views and
    -- writes one page_view engagement event per (person, path, minute). A
    -- (path, hat, day) total is published, rounded down to 5, only when it is
    -- itself at least privacy_threshold and at least privacy_threshold
    -- distinct people viewed that path that day (the page_view events carry
    -- the path before '|'), so a request total never stands in for a small
    -- person cohort.
    'usageViews', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'path', v.path, 'hat', v.hat, 'day', v.day,
        'count', (pg_catalog.floor(v.view_count / 5.0) * 5)::integer
      ) order by v.day, v.path, v.hat)
      from public.organization_page_views v
      where v.organization_id = org
        and v.day > ((generated - interval '30 days') at time zone 'UTC')::date
        and v.day <= (generated at time zone 'UTC')::date
        and v.view_count >= privacy_threshold
        and (
          select pg_catalog.count(distinct e.user_id)
          from public.organization_engagement_events e
          where e.organization_id = org and e.event_type = 'page_view'
            and e.occurred_at >= (v.day::timestamp at time zone 'UTC')
            and e.occurred_at < ((v.day + 1)::timestamp at time zone 'UTC')
            and pg_catalog.split_part(e.source_id, '|', 1) = v.path
        ) >= privacy_threshold
    ), '[]'::jsonb),
    'usageWindows', (
      select pg_catalog.jsonb_build_object(
        'organizationId', org,
        -- Distinct people with any engagement event (page views included) in
        -- the last day / 7 days / 30 days, rounded down to 5. Nested windows
        -- permit complement differencing, so an outer window is published only
        -- when the people it adds over the nearest published inner window also
        -- clear the floor.
        'dau', case when windows.dau_ok then (pg_catalog.floor(windows.dau / 5.0) * 5)::integer else null end,
        'wau', case when windows.wau_ok then (pg_catalog.floor(windows.wau / 5.0) * 5)::integer else null end,
        'mau', case when windows.mau_ok then (pg_catalog.floor(windows.mau / 5.0) * 5)::integer else null end,
        'suppressed', pg_catalog.jsonb_build_object(
          'dau', not windows.dau_ok,
          'wau', not windows.wau_ok,
          'mau', not windows.mau_ok
        )
      ) from (
        select gated.dau, gated.wau, gated.mau, gated.dau_ok, gated.wau_ok,
          gated.mau >= privacy_threshold
            and case
              when gated.wau_ok then gated.mau - gated.wau >= privacy_threshold
              when gated.dau_ok then gated.mau - gated.dau >= privacy_threshold
              else true
            end as mau_ok
        from (
          select counted.dau, counted.wau, counted.mau,
            counted.dau >= privacy_threshold as dau_ok,
            counted.wau >= privacy_threshold
              and (counted.dau < privacy_threshold or counted.wau - counted.dau >= privacy_threshold) as wau_ok
          from (
            select
              pg_catalog.count(distinct user_id) filter (where occurred_at >= generated - interval '1 day') as dau,
              pg_catalog.count(distinct user_id) filter (where occurred_at >= generated - interval '7 days') as wau,
              pg_catalog.count(distinct user_id) filter (where occurred_at >= generated - interval '30 days') as mau
            from public.organization_engagement_events where organization_id = org
          ) counted
        ) gated
      ) windows
    ),
    'series', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'chapterId', c.id,
        'openCases', case when case_totals.value >= privacy_threshold and case_totals.minimum_cell >= privacy_threshold
          then (pg_catalog.floor(case_totals.value / 5.0) * 5)::integer else null end,
        'openCasesSuppressed', case_totals.value < privacy_threshold or case_totals.minimum_cell < privacy_threshold,
        -- Share of recorded roster slots marked present over 180 days; guests
        -- are not on the roster. Published only when both the attending and
        -- the non-attending cohorts clear the person floor, so the rate cannot
        -- disclose a small absent cohort by complement.
        'attendanceRate', case when attendance_totals.present_people >= privacy_threshold
          and attendance_totals.missed_people >= privacy_threshold
          and attendance_totals.roster_rows > 0
          then pg_catalog.round(100.0 * attendance_totals.present_rows / attendance_totals.roster_rows, 0)
          else null end,
        -- Mean per-member engagement score (the client taxonomy's caps and
        -- weights, 180 days) over the chapter's active members.
        'engagementMean', case when engagement_totals.members >= privacy_threshold
          then pg_catalog.round(engagement_totals.mean_score, 1) else null end,
        -- Page-view totals are not person-level, so chapter portal use is the
        -- rounded 30-day distinct-person cohort of active members seen online.
        'usageViews', case when usage_totals.value >= privacy_threshold
          then (pg_catalog.floor(usage_totals.value / 5.0) * 5)::integer else null end
      ) order by c.id)
      from public.chapters c
      cross join lateral (
        select totals.value, minima.minimum_cell
        from (
          select pg_catalog.count(distinct cs.user_id) as value
          from public.member_cases cs
          where cs.organization_id = org and cs.chapter_id = c.id and cs.status = 'active'
            and cs.created_at >= period_start and cs.created_at < period_end
        ) totals
        cross join (
          select coalesce(pg_catalog.min(cell.cell_people), 0) as minimum_cell
          from (
            select pg_catalog.count(distinct cs.user_id) as cell_people
            from public.member_cases cs
            where cs.organization_id = org and cs.chapter_id = c.id and cs.status = 'active'
              and cs.created_at >= period_start and cs.created_at < period_end
            group by cs.case_type, case when cs.step in ('Intake', 'intake') then 0 else 2 end
          ) cell
        ) minima
      ) case_totals
      cross join lateral (
        select
          pg_catalog.count(distinct ma.user_id) filter (where ma.attendance_status = 'present') as present_people,
          pg_catalog.count(distinct ma.user_id) filter (where ma.attendance_status <> 'present') as missed_people,
          pg_catalog.count(*) as roster_rows,
          pg_catalog.count(*) filter (where ma.attendance_status = 'present') as present_rows
        from public.meeting_attendance ma
        join public.chapter_records r on r.id = ma.record_id and r.chapter_id = ma.chapter_id
        where ma.chapter_id = c.id
          and ma.attendance_status in ('present', 'absent', 'excused')
          and r.lifecycle_status <> 'archived'
          and r.occurred_at >= attendance_start and r.occurred_at <= generated
      ) attendance_totals
      cross join lateral (
        select pg_catalog.count(*) as members,
          coalesce(pg_catalog.avg(coalesce(scored.score, 0)), 0) as mean_score
        from public.member_chapter_memberships m
        left join (
          select per_type.user_id,
            least(100, pg_catalog.sum(least(per_type.event_count::numeric / weights.cap, 1) * weights.weight)) as score
          from (
            select e.user_id, e.event_type, pg_catalog.count(*) as event_count
            from public.organization_engagement_events e
            where e.organization_id = org and e.chapter_id = c.id
              and e.occurred_at >= generated - interval '180 days'
            group by e.user_id, e.event_type
          ) per_type
          join (values
            ('meeting_check_in', 10, 30),
            ('qa_contribution', 15, 25),
            ('poll_vote', 5, 10),
            ('survey_response', 3, 10),
            ('event_rsvp', 8, 15),
            ('authorized_contact', 5, 10)
          ) as weights(event_type, cap, weight) on weights.event_type = per_type.event_type
          group by per_type.user_id
        ) scored on scored.user_id = m.user_id
        where m.chapter_id = c.id and m.status = 'active'
      ) engagement_totals
      cross join lateral (
        select pg_catalog.count(distinct p.user_id) as value
        from public.member_presence p
        join public.member_chapter_memberships m
          on m.user_id = p.user_id and m.chapter_id = c.id and m.status = 'active'
        where p.organization_id = org and p.last_seen_at >= generated - interval '30 days'
      ) usage_totals
      where c.organization_id = org
    ), '[]'::jsonb),
    'heatmapPoints', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'kind', 'grievance', 'rowKey', counted.chapter_id,
        'colKey', counted.case_type,
        'count', (pg_catalog.floor(counted.person_count / 5.0) * 5)::integer
      ) order by counted.chapter_id, counted.case_type)
      from (
        with scoped as (
          select cs.user_id, cs.chapter_id, cs.case_type, cs.status,
            case when cs.step in ('Intake', 'intake') then 0 else 2 end as step_bucket
          from public.member_cases cs
          where cs.organization_id = org and cs.chapter_id is not null
            and cs.created_at >= period_start and cs.created_at < period_end
        ), totals as (
          select scoped.chapter_id, scoped.case_type,
            pg_catalog.count(distinct scoped.user_id) as person_count
          from scoped group by scoped.chapter_id, scoped.case_type
        ), minima as (
          select cells.chapter_id, cells.case_type, pg_catalog.min(cells.cell_people) as minimum_cell
          from (
            select scoped.chapter_id, scoped.case_type, scoped.status, scoped.step_bucket,
              pg_catalog.count(distinct scoped.user_id) as cell_people
            from scoped
            group by scoped.chapter_id, scoped.case_type, scoped.status, scoped.step_bucket
          ) cells
          group by cells.chapter_id, cells.case_type
        )
        select totals.chapter_id, totals.case_type, totals.person_count
        from totals join minima using (chapter_id, case_type)
        where totals.person_count >= privacy_threshold and minima.minimum_cell >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    'engagementCounts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'chapterId', counted.chapter_id,
        'eventType', counted.event_type,
        'count', (pg_catalog.floor(counted.person_count / 5.0) * 5)::integer
      ) order by counted.chapter_id, counted.event_type)
      from (
        select e.chapter_id, e.event_type, pg_catalog.count(distinct e.user_id) as person_count
        from public.organization_engagement_events e
        where e.organization_id = org
          and e.event_type <> 'page_view'
          and e.occurred_at >= generated - interval '180 days'
        group by e.chapter_id, e.event_type
        having pg_catalog.count(distinct e.user_id) >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    'engagementHistogram', pg_catalog.jsonb_build_object(
      'organizationId', org, 'privacyThreshold', privacy_threshold
    ),
    -- One row per recorded meeting in the last 180 days (newest 200). Counts
    -- are distinct people (one attendance row per record and member), rounded
    -- down to 5 and withheld below the person floor. The roster (rsvpGoing) is
    -- published only when the non-attending cohort also clears the floor, so
    -- rsvpGoing minus checkIns cannot disclose a small absent cohort.
    'attendanceEvents', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'id', counted.record_id, 'chapterId', counted.chapter_id,
        'startsAt', counted.occurred_at,
        'checkIns', case when counted.present_people >= privacy_threshold
          then (pg_catalog.floor(counted.present_people / 5.0) * 5)::integer else null end,
        'rsvpGoing', case when counted.present_people >= privacy_threshold
          and counted.roster_people - counted.present_people >= privacy_threshold
          then (pg_catalog.floor(counted.roster_people / 5.0) * 5)::integer else null end
      ) order by counted.occurred_at desc, counted.record_id)
      from (
        select r.id as record_id, r.chapter_id, r.occurred_at,
          pg_catalog.count(*) filter (where ma.attendance_status = 'present') as present_people,
          pg_catalog.count(*) filter (where ma.attendance_status in ('present', 'absent', 'excused')) as roster_people
        from public.chapter_records r
        join public.chapters c on c.id = r.chapter_id and c.organization_id = org
        join public.meeting_attendance ma on ma.record_id = r.id and ma.chapter_id = r.chapter_id
        where r.lifecycle_status <> 'archived'
          and r.occurred_at >= attendance_start and r.occurred_at <= generated
        group by r.id, r.chapter_id, r.occurred_at
        order by r.occurred_at desc, r.id
        limit 200
      ) counted
    ), '[]'::jsonb),
    'attendanceCohorts', pg_catalog.jsonb_build_object(
      'organizationId', org, 'firstTime', null, 'repeat', null, 'suppressed', true
    )
  );
  -- Server-derived export counts for this issued snapshot: every published
  -- row, and the rows that carry at least one withheld (null) measure.
  select pg_catalog.count(*)::integer,
    (pg_catalog.count(*) filter (where exists (
      select 1 from pg_catalog.jsonb_each(published.value) field
      where field.value = 'null'::jsonb
    )))::integer
  into published_rows, withheld_rows
  from pg_catalog.jsonb_array_elements(
    (result -> 'chapters') || (result -> 'cases') || (result -> 'series')
      || (result -> 'heatmapPoints') || (result -> 'engagementCounts')
      || (result -> 'attendanceEvents')
  ) published;
  result := result || pg_catalog.jsonb_build_object('snapshotId', snapshot_id);
  perform private.mi1_write_tenant_audit(org, 'analytics_snapshot_read', pg_catalog.jsonb_build_object(
    'organizationId', org, 'surface', 'organization_analytics_snapshot',
    'entityId', snapshot_id, 'rowCount', published_rows, 'suppressedCount', withheld_rows
  ));
  return result;
end;
end;
$function$;


-- Re-emitted from 20261018022908_concurrent_lifecycle_read_admission.sql; only the platform boundary changes.
CREATE OR REPLACE FUNCTION public.get_organization_analytics_workspace()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph_read();
  perform private.member_pin_require_full_session();
declare
  org uuid := private.mi1_require_selected_organization();
  generated timestamptz := pg_catalog.now();
  privacy_threshold integer := private.organization_limit(org, 'limits.analytics.anonymity_floor');
  health_threshold integer := private.organization_limit(org, 'limits.analytics.chapter_health_cohort_floor');
  actor uuid := (select auth.uid());
  may_read_unassigned boolean;
begin
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if org is null then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Necessary candidate condition only, never an authorization result.
  -- Deliberately retain roles in ANY tenant/chapter (including inactive or
  -- otherwise unusable grants): false positives still reach the shared final
  -- predicate. All current organization, chapter and legacy role sources are
  -- included. Assignment is checked per case below.
  may_read_unassigned := exists (
    select 1 from public.organization_role_grants g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  ) or exists (
    select 1 from public.member_role_chapters g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  ) or exists (
    select 1 from public.member_roles g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  );

  perform private.mi1_write_tenant_audit(org, 'analytics_snapshot_read', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surface', 'analytics_parity_workspace'
  ));

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'generatedAt', generated,
    'privacyThreshold', privacy_threshold,
    'chapterHealthFloor', health_threshold,
    'members', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'id', m.user_id::text || ':' || m.chapter_id,
        'name', p.full_name,
        'chapterId', c.id,
        'chapterName', c.name,
        'participationScore', least(100, activity.event_count * 10),
        'profileReadiness',
          (case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end) + 50,
        'followThrough', least(100, activity.follow_count * 20),
        'overallScore', pg_catalog.round((
          least(100, activity.event_count * 10)
          + ((case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end) + 50)
          + least(100, activity.follow_count * 20)
        )::numeric / 3),
        'attention', case
          when cases.overdue_cases > 0 then 'urgent'
          when activity.event_count = 0 then 'support'
          when activity.event_count < 5 then 'watch'
          else 'steady'
        end,
        'activeCases', cases.active_cases,
        'overdueCases', cases.overdue_cases,
        'lastActivityAt', activity.last_activity
      ) order by c.name, p.full_name, m.user_id)
      from public.member_chapter_memberships m
      join public.chapters c on c.id = m.chapter_id and c.organization_id = org
      join public.organization_memberships om
        on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
      join public.member_profiles p on p.id = m.user_id
      cross join lateral (
        select
          pg_catalog.count(*)::integer as event_count,
          pg_catalog.count(*) filter (
            where e.event_type in ('authorized_contact', 'survey_response', 'event_rsvp')
              and e.occurred_at >= generated - interval '90 days'
          )::integer as follow_count,
          pg_catalog.max(e.occurred_at) as last_activity
        from public.organization_engagement_events e
        where e.organization_id = org
          and e.user_id = m.user_id
          -- Preserve train 2a participation semantics: page views are telemetry.
          and e.event_type <> 'page_view'
          and e.occurred_at >= generated - interval '180 days'
      ) activity
      cross join lateral (
        select
          pg_catalog.count(*) filter (where cs.status = 'active')::integer as active_cases,
          pg_catalog.count(*) filter (
            where cs.status = 'active' and cs.deadline < generated::date
          )::integer as overdue_cases
        from public.member_cases cs
        where cs.organization_id = org
          and cs.chapter_id = c.id
          and cs.user_id = m.user_id
          and cs.status = 'active'
          and (may_read_unassigned or cs.steward_user_id = actor or cs.coordinator_user_id = actor)
          and private.casework_staff_can_access(cs.id)
      ) cases
      where m.status = 'active'
    ), '[]'::jsonb),
    'chapterHealth', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'chapterId', c.id,
        'chapterName', c.name,
        'memberCount', totals.member_count,
        'protected', totals.member_count < health_threshold,
        'score', case when totals.member_count >= health_threshold then latest.score else null end,
        'drivers', case when totals.member_count >= health_threshold and latest.id is not null
          then pg_catalog.jsonb_build_object(
            'participation', latest.participation,
            'caseTimeliness', latest.case_timeliness,
            'stewardCapacity', latest.steward_capacity,
            'trainingCoverage', latest.training_coverage,
            'communicationReach', latest.communication_reach,
            'governanceReadiness', latest.governance_readiness
          ) else null end,
        'trend', case when totals.member_count >= health_threshold then coalesce(trend.points, '[]'::jsonb) else '[]'::jsonb end
      ) order by c.name)
      from public.chapters c
      cross join lateral (
        select pg_catalog.count(*)::integer as member_count
        from public.member_chapter_memberships m
        join public.organization_memberships om
          on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
        where m.chapter_id = c.id and m.status = 'active'
      ) totals
      left join lateral (
        select s.* from public.chapter_health_snapshots s
        where s.chapter_id = c.id order by s.measured_on desc limit 1
      ) latest on true
      left join lateral (
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'measuredOn', history.measured_on, 'score', history.score
        ) order by history.measured_on) as points
        from (
          select s.measured_on, s.score
          from public.chapter_health_snapshots s
          where s.chapter_id = c.id
          order by s.measured_on desc limit 36
        ) history
      ) trend on true
      where c.organization_id = org
    ), '[]'::jsonb),
    'datasets', coalesce((
      select pg_catalog.jsonb_agg(dataset.value order by dataset.sort_key)
      from (
        select 0 as sort_key, pg_catalog.jsonb_build_object(
          'organizationId', org,
          'id', 'organization:chapter-health',
          'label', 'Chapter health',
          'description', 'Latest protected chapter health score.',
          'scope', 'organization',
          'chapterId', null,
          'rows', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'label', qualified.name, 'value', qualified.score
          ) order by qualified.name), '[]'::jsonb)
        ) as value
        from (
          select c.name, latest.score
          from public.chapters c
          cross join lateral (
            select pg_catalog.count(*)::integer as member_count
            from public.member_chapter_memberships m
            join public.organization_memberships om
              on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
            where m.chapter_id = c.id and m.status = 'active'
          ) totals
          join lateral (
            select s.score from public.chapter_health_snapshots s
            where s.chapter_id = c.id order by s.measured_on desc limit 1
          ) latest on true
          where c.organization_id = org and totals.member_count >= health_threshold
        ) qualified
        union all
        select 100 + c.order_index, pg_catalog.jsonb_build_object(
          'organizationId', org,
          'id', 'chapter:' || c.id || ':health-trend',
          'label', c.name || ' health trend',
          'description', 'Protected chapter score history.',
          'scope', 'chapter',
          'chapterId', c.id,
          'rows', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'label', s.measured_on::text, 'value', s.score
            ) order by s.measured_on)
            from public.chapter_health_snapshots s where s.chapter_id = c.id
          ), '[]'::jsonb)
        )
        from public.chapters c
        where c.organization_id = org
          and (select pg_catalog.count(*) from public.member_chapter_memberships m
               join public.organization_memberships om
                 on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
               where m.chapter_id = c.id and m.status = 'active') >= privacy_threshold
      ) dataset
    ), '[]'::jsonb),
    'layouts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', l.id,
        'organizationId', l.organization_id,
        'name', l.name,
        'scope', l.scope,
        'chapterId', l.chapter_id,
        'spec', l.spec,
        'canEdit', l.owner_user_id = (select auth.uid())
          or private.has_organization_role(org, array['admin']),
        'updatedAt', l.updated_at
      ) order by l.updated_at desc)
      from public.organization_analytics_layouts l
      where l.organization_id = org
        and (
          (l.scope = 'personal' and l.owner_user_id = (select auth.uid()))
          or l.scope in ('chapter', 'organization')
        )
    ), '[]'::jsonb)
  );
end;
end;
$function$;

-- Re-emitted from 20260925160000_analytics_export_server_derived_counts.sql; only the platform boundary changes.
create or replace function public.request_organization_analytics_export(
  p_format text,
  p_snapshot_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  org uuid := private.mi1_require_selected_organization();
  caller uuid := (select auth.uid());
  created uuid;
  expires timestamptz := pg_catalog.now() + interval '24 hours';
  fmt text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_format, '')));
  issued jsonb;
  rows integer;
  suppressed integer;
begin
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['coordinator', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if fmt not in ('csv', 'json') or p_snapshot_id is null then
    raise exception 'invalid export request' using errcode = '22023';
  end if;
  -- The counts come from the snapshot the server issued to this caller in
  -- this organization, never from the request.
  select e.metadata into issued
  from public.organization_audit_events e
  where e.organization_id = org
    and e.created_at >= pg_catalog.now() - interval '24 hours'
    and e.event_type = 'analytics_snapshot_read'
    and e.actor_user_id = caller
    and e.metadata ->> 'entityId' = p_snapshot_id::text
  order by e.created_at desc, e.id desc
  limit 1;
  if issued is null
     or pg_catalog.jsonb_typeof(issued -> 'rowCount') is distinct from 'number'
     or pg_catalog.jsonb_typeof(issued -> 'suppressedCount') is distinct from 'number' then
    raise exception 'analytics snapshot unavailable' using errcode = '22023';
  end if;
  rows := (issued ->> 'rowCount')::integer;
  suppressed := (issued ->> 'suppressedCount')::integer;
  insert into public.organization_analytics_exports (
    organization_id, export_format, expires_at, created_by, row_count, suppressed_count
  ) values (org, fmt, expires, caller, rows, suppressed)
  returning id into created;
  perform private.mi1_write_tenant_audit(org, 'analytics_export_requested', pg_catalog.jsonb_build_object(
    'organizationId', org, 'exportFormat', fmt, 'expiresAt', expires,
    'rowCount', rows, 'suppressedCount', suppressed, 'entityId', p_snapshot_id
  ));
  return pg_catalog.jsonb_build_object(
    'id', created, 'organizationId', org, 'format', fmt, 'expiresAt', expires,
    'rowCount', rows, 'suppressedCount', suppressed, 'snapshotId', p_snapshot_id
  );
end;
end;
$function$;


-- Re-emitted from 20260930040000_union_catalog_claims_verification.sql; only the platform boundary changes.
create or replace function public.get_organization_catalog_verification(
  p_selected_hat text,
  p_expected_organization_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  placement private.organization_catalog_placements%rowtype;
  verified_identity jsonb;
  open_claim jsonb;
begin
  org := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_selected_hat is distinct from 'admin'
     or not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select * into placement
    from private.organization_catalog_placements as p
   where p.organization_id = org;
  if found and placement.verified_at is not null then
    if placement.identity_catalog_key is not null then
      verified_identity := pg_catalog.jsonb_build_object(
        'kind', 'catalog',
        'catalogKey', placement.identity_catalog_key,
        'name', (select o.name from private.catalog_organizations as o
                  where o.catalog_key = placement.identity_catalog_key));
    else
      verified_identity := pg_catalog.jsonb_build_object(
        'kind', 'unlisted',
        'catalogKey', null,
        'name', (select o.name from public.organizations as o where o.id = org));
    end if;
  end if;

  select pg_catalog.jsonb_build_object(
           'state', case when c.status = 'awaiting_email' then 'awaiting_email' else 'in_review' end,
           'catalogKey', c.catalog_key)
    into open_claim
    from private.organization_claims as c
   where c.organization_id = org
     and c.status in ('awaiting_email', 'under_review', 'held')
     and (c.status <> 'awaiting_email' or c.confirm_expires_at > pg_catalog.now())
   order by c.created_at desc
   limit 1;

  return pg_catalog.jsonb_build_object(
    'verification', pg_catalog.jsonb_build_object(
      'status', case when verified_identity is not null then 'verified' else 'self_reported' end,
      'identity', verified_identity,
      'verifiedAt', case when verified_identity is not null then placement.verified_at end),
    'openClaim', open_claim
  );
end;
$function$;


-- Re-emitted from 20261010130000_ai_usage_digest.sql; only the platform boundary changes.
create or replace function private.usage_digest_staff_organization(p_selected_hat text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  hat text := coalesce(nullif(pg_catalog.btrim(coalesce(p_selected_hat, '')), ''), '');
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  org := private.mi1_require_selected_organization();
  if hat not in ('steward', 'coordinator', 'advisor', 'admin', 'vp') then
    raise exception 'staff hat required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array[hat]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  return org;
end;
$function$;


-- Re-emitted from 20261021020656_concurrent_telemetry_lifecycle_admission.sql; only the platform boundary changes.
create or replace function public.record_workspace_page_view(p_page text, p_hat text DEFAULT 'member'::text, p_organization_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_lifecycle_telemetry(auth.uid(), null);
declare
  caller uuid := (select auth.uid());
  org uuid := private.engagement_selected_organization();
  moment timestamptz := pg_catalog.now();
  page_key text := pg_catalog.btrim(coalesce(p_page, ''));
  recorded_hat text := 'member';
  minute_key text := pg_catalog.to_char(moment at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI');
  recent integer;
  inserted boolean := false;
begin
  if caller is null or org is null or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if not private.organization_is_union(org) then
    return pg_catalog.jsonb_build_object('recorded', false);
  end if;
  if p_organization_id is not null and p_organization_id is distinct from org then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if pg_catalog.char_length(page_key) < 1 or pg_catalog.char_length(page_key) > 100
     or page_key !~ '^/[A-Za-z0-9/_.:-]*$' then
    raise exception 'invalid page key' using errcode = '22023';
  end if;
  if p_hat in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
     and private.has_organization_role(org, array[p_hat]) then
    recorded_hat := p_hat;
  end if;

  select pg_catalog.count(*) into recent
  from public.organization_engagement_events e
  where e.user_id = caller and e.event_type = 'page_view'
    and e.occurred_at >= moment - interval '1 minute';
  if recent >= 30 then
    return pg_catalog.jsonb_build_object('recorded', false, 'refusal', 'rate-limited');
  end if;

  insert into public.organization_engagement_events
    (organization_id, user_id, chapter_id, event_type, source_id, occurred_at)
  values (org, caller, private.current_member_chapter(), 'page_view', page_key || '|' || minute_key, moment)
  on conflict (organization_id, user_id, event_type, source_id) do nothing;
  inserted := found;
  if inserted then
    insert into public.organization_page_views (organization_id, path, hat, day, view_count)
    values (org, page_key, recorded_hat, (moment at time zone 'UTC')::date, 1)
    on conflict (organization_id, path, hat, day) do update
      set view_count = public.organization_page_views.view_count + 1;
  end if;
  return pg_catalog.jsonb_build_object('recorded', inserted);
end;
end;
$function$;


-- Hide pre-existing cross-tenant projections even if an operator classifies
-- an organization after it had opted into discovery. Own member/account
-- authorization is deliberately unchanged.
create policy platform_directory_boundary on public.organization_network_directory_profiles
as restrictive for select to authenticated
using (private.organization_is_union(organization_id));
create policy platform_binding_boundary on public.chapter_union_org_bindings
as restrictive for select to authenticated
using (not private.chapter_belongs_to_platform(chapter_id));
comment on policy platform_directory_boundary on public.organization_network_directory_profiles is
  'Defense in depth: previously published internal platform profiles never enter another organization directory.';
comment on policy platform_binding_boundary on public.chapter_union_org_bindings is
  'Internal platform chapters cannot appear as verified union registry bindings; ownerless legacy chapters keep their ordinary visibility.';

-- Re-emitted from 20261002135600_restore_review_hotfixes.sql; only the platform
-- boundary changes: the filtered export refuses a platform organization right
-- after context resolution, like the analytics export above. Grants are kept.
create or replace function public.request_filtered_organization_export(p_domains text[], p_format text default 'csv'::text, p_from timestamp with time zone default null::timestamp with time zone, p_to timestamp with time zone default null::timestamp with time zone, p_idempotency_key uuid default null::uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  ctx record;
  clean_domains text[];
  rows jsonb;
  total integer;
  receipt uuid;
  expires timestamptz := pg_catalog.now() + interval '15 minutes';
  prior public.organization_data_export_runs%rowtype;
  recent_requests integer;
begin
  select * into ctx from private.institutional_context(true);
  if not private.organization_is_union(ctx.organization_id) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if not private.has_organization_role(ctx.organization_id, array['admin','vp']) then
    raise exception 'organization export role required' using errcode = '42501';
  end if;
  delete from public.organization_data_export_runs
  where organization_id = ctx.organization_id and expires_at <= pg_catalog.now();
  select pg_catalog.array_agg(domain order by domain) into clean_domains
  from (
    select distinct pg_catalog.btrim(value) as domain
    from pg_catalog.unnest(coalesce(p_domains, '{}'::text[])) value
  ) selected
  where domain = any(array['members','cases','tasks','minutes','timeline','contacts']::text[]);
  if p_format not in ('csv','json','xlsx')
     or (p_format = 'xlsx' and not private.organization_feature_enabled(ctx.organization_id, 'features.analytics.filtered_export_xlsx'))
     or pg_catalog.cardinality(clean_domains) not between 1 and 6
     or pg_catalog.cardinality(clean_domains) <> pg_catalog.cardinality(p_domains)
     or (p_from is not null and p_to is not null and p_from > p_to) then
    raise exception 'invalid export request' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('filtered-export:' || ctx.organization_id::text, 509)
  );
  if p_idempotency_key is not null then
    select * into prior from public.organization_data_export_runs r
    where r.organization_id = ctx.organization_id and r.requested_by = ctx.caller_id
      and r.idempotency_key = p_idempotency_key and r.expires_at > pg_catalog.now();
    if prior.id is not null and (
      prior.format <> p_format or prior.domains <> clean_domains
      or prior.filters <> pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('from', p_from, 'to', p_to))
    ) then
      raise exception 'invalid export request' using errcode = '22023';
    end if;
  end if;
  if prior.id is null then
    select pg_catalog.count(*)::integer into recent_requests
    from public.organization_audit_events e
    where e.organization_id = ctx.organization_id
      and e.event_type = 'organization_export_completed'
      and e.metadata->>'exportType' = 'filtered'
      and e.created_at > pg_catalog.now() - interval '1 hour';
    -- 30 filtered export requests per organization per rolling hour.
    if recent_requests >= 30 then
      raise exception 'export request limit reached: 30 per hour' using errcode = '54000';
    end if;
  end if;

  with export_rows as (
    select 'members'::text as domain, p.created_at as occurred_at,
      pg_catalog.jsonb_build_object(
        'memberId', p.id, 'name', p.full_name, 'memberSince', p.member_since,
        'chapterId', membership.chapter_id
      ) as values
    from public.member_profiles p
    join lateral (
      select cm.chapter_id
      from public.member_chapter_memberships cm
      join public.chapters c on c.id = cm.chapter_id
      where cm.user_id = p.id and cm.status = 'active' and c.organization_id = ctx.organization_id
      order by cm.chapter_id
      limit 1
    ) membership on true
    where 'members' = any(clean_domains)
    union all
    -- A case belongs to its own organization and chapter, never to the
    -- member's current profile placement. Restricted cases are exported only
    -- when the exporter may read them under the casework access rule.
    select 'cases', c.updated_at,
      pg_catalog.jsonb_build_object(
        'caseId', c.id, 'reference', c.reference, 'title', c.title, 'type', c.case_type,
        'step', c.step, 'status', c.status, 'deadline', c.deadline, 'memberId', c.user_id,
        'chapterId', c.chapter_id
      )
    from public.member_cases c
    where 'cases' = any(clean_domains) and c.organization_id = ctx.organization_id
      and (not c.is_restricted or private.casework_staff_can_access(c.id))
    union all
    select 'tasks', t.updated_at,
      pg_catalog.jsonb_build_object(
        'taskId', t.id, 'title', t.title, 'status', t.status, 'priority', t.priority,
        'workstream', t.workstream, 'dueDate', t.due_date, 'progress', t.progress,
        'blocked', t.blocked, 'chapterId', t.chapter_id
      )
    from public.chapter_tasks t join public.chapters ch on ch.id = t.chapter_id
    where 'tasks' = any(clean_domains) and ch.organization_id = ctx.organization_id
      and t.deleted_at is null
    union all
    select 'minutes', r.occurred_at,
      pg_catalog.jsonb_build_object(
        'recordId', r.id, 'title', r.title, 'occurredAt', r.occurred_at,
        'status', r.lifecycle_status, 'visibility', r.visibility, 'version', r.version,
        'chapterId', r.chapter_id
      )
    from public.chapter_records r join public.chapters ch on ch.id = r.chapter_id
    where 'minutes' = any(clean_domains) and ch.organization_id = ctx.organization_id
      and r.record_type = 'minutes' and r.archived_at is null
    union all
    select 'timeline', r.occurred_at,
      pg_catalog.jsonb_build_object(
        'recordId', r.id, 'type', r.record_type, 'title', r.title, 'body', r.body,
        'occurredAt', r.occurred_at, 'status', r.lifecycle_status,
        'visibility', r.visibility, 'version', r.version, 'pinned', r.pinned_at is not null,
        'gapNote', r.gap_note, 'chapterId', r.chapter_id
      )
    from public.chapter_records r join public.chapters ch on ch.id = r.chapter_id
    where 'timeline' = any(clean_domains) and ch.organization_id = ctx.organization_id
      and r.record_type in ('decision','milestone') and r.archived_at is null
    union all
    select 'contacts', l.occurred_at,
      pg_catalog.jsonb_build_object(
        'contactId', l.id, 'kind', l.contact_kind, 'channel', l.channel,
        'purpose', l.purpose, 'summary', l.summary, 'outcome', l.outcome,
        'occurredAt', l.occurred_at, 'followUpAt', l.follow_up_at,
        'subjectMemberId', l.subject_user_id, 'caseId', l.case_id, 'taskId', l.task_id,
        'chapterId', l.chapter_id
      )
    from public.chapter_contact_log l
    where 'contacts' = any(clean_domains) and l.organization_id = ctx.organization_id and l.archived_at is null
  ), bounded as (
    select * from export_rows
    where (p_from is null or occurred_at >= p_from)
      and (p_to is null or occurred_at <= p_to)
    order by occurred_at desc, domain, values::text
    limit 10001
  )
  select pg_catalog.count(*)::integer,
    coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('domain', domain, 'occurredAt', occurred_at, 'values', values) order by occurred_at desc, domain), '[]'::jsonb)
  into total, rows from bounded;

  if total > 10000 then
    raise exception 'export exceeds 10000 rows; narrow the date range or domains' using errcode = '54000';
  end if;

  if prior.id is not null then
    receipt := prior.id;
    expires := prior.expires_at;
  else
  insert into public.organization_data_export_runs (
    organization_id, requested_by, format, domains, filters, row_count, expires_at, idempotency_key
  ) values (
    ctx.organization_id, ctx.caller_id, p_format, clean_domains,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('from', p_from, 'to', p_to)),
    total, expires, p_idempotency_key
  ) returning id into receipt;

  perform private.mi1_w2_write_audit(
    ctx.organization_id,
    'organization_export_completed',
    pg_catalog.jsonb_build_object(
      'exportType', 'filtered',
      'exportFormat', p_format,
      'rowCount', total,
      'status', 'completed'
    )
  );
  end if;

  return pg_catalog.jsonb_build_object(
    'receiptId', receipt, 'format', p_format, 'domains', clean_domains,
    'rowCount', total, 'expiresAt', expires, 'rows', rows
  );
end;
end;
$function$;

-- Re-emitted from 20260828220000_mi1_voice_survey_completion.sql; retain staff authorization and privacy
-- checks, and refuse platform exports before reading retained responses.
create or replace function public.export_organization_survey_results(p_survey_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  survey public.organization_surveys%rowtype;
  report jsonb;
begin
  perform private.engagement_require_staff(org);
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  select * into survey from public.organization_surveys
  where id = p_survey_id and organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  report := public.get_organization_survey_report(survey.id);
  if not coalesce((report ->> 'available')::boolean, false) then
    return report || pg_catalog.jsonb_build_object(
      'title', survey.title,
      'generatedAt', pg_catalog.now(),
      'responses', '[]'::jsonb
    );
  end if;
  return report || pg_catalog.jsonb_build_object(
    'generatedAt', pg_catalog.now(),
    'responses', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'responseId', session.id,
        'submittedAt', session.submitted_at,
        'answers', coalesce((
          select pg_catalog.jsonb_object_agg(answer.question_id::text, answer.value)
          from public.organization_survey_answers answer
          where answer.session_id = session.id and answer.organization_id = org
        ), '{}'::jsonb)
      ) order by session.submitted_at, session.id)
      from public.organization_survey_sessions session
      where session.organization_id = org
        and session.survey_id = survey.id
        and session.status = 'submitted'
    ), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.export_organization_survey_results(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.export_organization_survey_results(uuid) to authenticated;

-- Re-emitted from 20261002102000_survey_follow_up_and_exports.sql; retain staff authorization and privacy
-- checks, and refuse platform exports before reading retained responses.
create or replace function public.export_organization_survey_window(
  p_survey_id uuid,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_format text default 'csv'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.engagement_selected_organization();
  report jsonb;
  responses jsonb;
begin
  perform private.engagement_require_staff(org);
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if p_format is null or p_format not in ('csv', 'xlsx', 'json') then
    raise exception 'invalid export format' using errcode = '22023';
  end if;
  report := public.get_organization_survey_report_window(p_survey_id, p_from, p_to);
  if not coalesce((report ->> 'available')::boolean, false) then
    raise exception 'privacy floor not met' using errcode = '22023';
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'responseId', session.id,
    'submittedAt', session.submitted_at,
    'answers', coalesce((
      select pg_catalog.jsonb_object_agg(answer.question_id::text, answer.value)
      from public.organization_survey_answers answer
      where answer.session_id = session.id and answer.organization_id = org
    ), '{}'::jsonb)
  ) order by session.submitted_at, session.id), '[]'::jsonb)
  into responses
  from public.organization_survey_sessions session
  where session.id in (select private.survey_window_sessions(org, p_survey_id, p_from, p_to));
  perform private.mi1_w2_write_audit(org, 'organization_export_completed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'surveyId', p_survey_id, 'userId', (select auth.uid()),
    'exportType', 'survey', 'exportFormat', p_format,
    'rowCount', pg_catalog.jsonb_array_length(responses), 'status', 'completed'
  ));
  return report || pg_catalog.jsonb_build_object(
    'format', p_format,
    'generatedAt', pg_catalog.now(),
    'responses', responses
  );
end;
end;
$function$;

revoke all on function public.export_organization_survey_window(uuid, timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function public.export_organization_survey_window(uuid, timestamptz, timestamptz, text) to authenticated;

-- Complete export/result entry-point boundary. Re-emitted from the catalog
-- after replay through this migration; existing auth, privacy, row bounds,
-- output shape and ACLs remain. Batch workers skip platform-owned records.
-- Platform export boundary: public.get_bargaining_survey_results(uuid)
CREATE OR REPLACE FUNCTION public.get_bargaining_survey_results(p_survey_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.engagement_selected_organization();
  survey public.organization_surveys%rowtype;
  organization_name text;
  floor_size integer;
  responses integer;
  first_submitted timestamptz;
  last_submitted timestamptz;
  base jsonb;
begin
  perform private.engagement_require_staff(org);
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.engagement_voice.bargaining_survey_template') then
    raise exception 'bargaining survey template is off for this organization' using errcode = '42501';
  end if;
  select * into survey from public.organization_surveys
  where id = p_survey_id and organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from public.organization_survey_questions question
    where question.survey_id = survey.id and question.organization_id = org
      and pg_catalog.starts_with(question.section_key, 'bargaining-v1:')
  ) then
    raise exception 'not a bargaining survey' using errcode = 'P0002';
  end if;
  select o.name into organization_name from public.organizations o where o.id = org;
  floor_size := greatest(
    25,
    coalesce(private.organization_limit(org, 'limits.analytics.anonymity_floor'), 25),
    survey.privacy_min_responses
  );
  select pg_catalog.count(*)::integer, pg_catalog.min(session.submitted_at), pg_catalog.max(session.submitted_at)
  into responses, first_submitted, last_submitted
  from public.organization_survey_sessions session
  where session.organization_id = org and session.survey_id = survey.id and session.status = 'submitted';

  base := pg_catalog.jsonb_build_object(
    'surveyId', survey.id,
    'organizationName', organization_name,
    'title', survey.title,
    'status', survey.status,
    'surveyUpdatedAt', survey.updated_at,
    'opensAt', survey.opens_at,
    'closesAt', survey.closes_at,
    'generatedAt', pg_catalog.now(),
    'responseCount', responses,
    'minimumResponses', floor_size
  );
  if responses < floor_size then
    return base || pg_catalog.jsonb_build_object('available', false, 'questions', '[]'::jsonb);
  end if;

  return base || pg_catalog.jsonb_build_object(
    'available', true,
    'firstSubmittedAt', first_submitted,
    'lastSubmittedAt', last_submitted,
    'questions', coalesce((
      select pg_catalog.jsonb_agg(
        case when counted.answered < floor_size then pg_catalog.jsonb_build_object(
          'id', counted.id, 'clientKey', counted.client_key, 'sectionKey', counted.section_key,
          'type', counted.question_type, 'label', counted.label, 'options', counted.options,
          'withheld', true, 'answered', null, 'distribution', '[]'::jsonb
        ) else pg_catalog.jsonb_build_object(
          'id', counted.id, 'clientKey', counted.client_key, 'sectionKey', counted.section_key,
          'type', counted.question_type, 'label', counted.label, 'options', counted.options,
          'withheld', false, 'answered', counted.answered,
          'distribution', case
            when counted.question_type in ('text', 'paragraph') then '[]'::jsonb
            when counted.question_type = 'checkbox' then (
              select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('value', bucket.value, 'count', bucket.count) order by bucket.value), '[]'::jsonb)
              from (
                select chosen.value, pg_catalog.count(distinct answer.session_id)::integer as count
                from public.organization_survey_answers answer
                join public.organization_survey_sessions session
                  on session.id = answer.session_id and session.organization_id = org
                 and session.survey_id = survey.id and session.status = 'submitted'
                cross join lateral pg_catalog.jsonb_array_elements(
                  case when pg_catalog.jsonb_typeof(answer.value) = 'array' then answer.value else '[]'::jsonb end
                ) chosen(value)
                where answer.question_id = counted.id and answer.organization_id = org
                group by chosen.value
              ) bucket
            )
            else (
              select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('value', bucket.value, 'count', bucket.count) order by bucket.value), '[]'::jsonb)
              from (
                select answer.value, pg_catalog.count(*)::integer as count
                from public.organization_survey_answers answer
                join public.organization_survey_sessions session
                  on session.id = answer.session_id and session.organization_id = org
                 and session.survey_id = survey.id and session.status = 'submitted'
                where answer.question_id = counted.id and answer.organization_id = org
                group by answer.value
              ) bucket
            )
          end
        ) end
        order by counted.sort_index, counted.id
      )
      from (
        select question.id, question.client_key, question.section_key, question.question_type,
          question.label, question.options, question.sort_index,
          (
            select pg_catalog.count(*)::integer
            from public.organization_survey_answers answer
            join public.organization_survey_sessions session
              on session.id = answer.session_id and session.organization_id = org
             and session.survey_id = survey.id and session.status = 'submitted'
            where answer.question_id = question.id and answer.organization_id = org
              and answer.value not in ('null'::jsonb, '[]'::jsonb, '""'::jsonb)
          ) as answered
        from public.organization_survey_questions question
        where question.survey_id = survey.id and question.organization_id = org
      ) counted
    ), '[]'::jsonb)
  );
end;
$function$;
revoke all on function public.get_bargaining_survey_results(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_bargaining_survey_results(uuid) to authenticated;

-- Platform export boundary: public.get_organization_survey_report(uuid)
CREATE OR REPLACE FUNCTION public.get_organization_survey_report(p_survey_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.engagement_selected_organization();
  survey public.organization_surveys%rowtype;
  responses integer;
begin
  perform private.engagement_require_staff(org);
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  select * into survey from public.organization_surveys
  where id = p_survey_id and organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  -- REQ-UG-BARGAINING-SURVEY-20261012: a bargaining survey reports
  -- totals only, through get_bargaining_survey_results.
  if exists (
    select 1 from public.organization_survey_questions question
    where question.survey_id = survey.id
      and pg_catalog.starts_with(question.section_key, 'bargaining-v1:')
  ) then
    raise exception 'a bargaining survey reports totals only' using errcode = '42501';
  end if;
  select pg_catalog.count(*)::integer into responses
  from public.organization_survey_sessions session
  where session.organization_id = org and session.survey_id = survey.id and session.status = 'submitted';
  if responses < survey.privacy_min_responses then
    return pg_catalog.jsonb_build_object(
      'surveyId', survey.id,
      'responseCount', responses,
      'privacyMinResponses', survey.privacy_min_responses,
      'available', false,
      'questions', '[]'::jsonb
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'surveyId', survey.id,
    'title', survey.title,
    'responseCount', responses,
    'privacyMinResponses', survey.privacy_min_responses,
    'available', true,
    'questions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', question.id,
        'label', question.label,
        'type', question.question_type,
        'answered', (
          select pg_catalog.count(*)
          from public.organization_survey_answers answer
          join public.organization_survey_sessions session on session.id = answer.session_id
          where answer.question_id = question.id and session.status = 'submitted'
        ),
        'distribution', case
          when question.question_type in ('radio', 'dropdown', 'yes_no', 'scale', 'rating') then (
            select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('value', bucket.value, 'count', bucket.count) order by bucket.value), '[]'::jsonb)
            from (
              select answer.value, pg_catalog.count(*)::integer as count
              from public.organization_survey_answers answer
              join public.organization_survey_sessions session on session.id = answer.session_id
              where answer.question_id = question.id and session.status = 'submitted'
              group by answer.value
            ) bucket
          )
          else '[]'::jsonb
        end
      ) order by question.sort_index)
      from public.organization_survey_questions question
      where question.survey_id = survey.id and question.organization_id = org
    ), '[]'::jsonb)
  );
end;
$function$;
revoke all on function public.get_organization_survey_report(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_organization_survey_report(uuid) to authenticated;

-- Platform export boundary: public.get_organization_survey_report_window(uuid, timestamp with time zone, timestamp with time zone)
CREATE OR REPLACE FUNCTION public.get_organization_survey_report_window(p_survey_id uuid, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.engagement_selected_organization();
  survey public.organization_surveys%rowtype;
  responses integer;
begin
  perform private.engagement_require_staff(org);
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.engagement_voice.survey_report_exports') then
    raise exception 'survey report exports are turned off' using errcode = '55000';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'invalid report window' using errcode = '22023';
  end if;
  select * into survey from public.organization_surveys
  where id = p_survey_id and organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  -- REQ-UG-BARGAINING-SURVEY-20261012: a bargaining survey reports
  -- totals only, through get_bargaining_survey_results.
  if exists (
    select 1 from public.organization_survey_questions question
    where question.survey_id = survey.id
      and pg_catalog.starts_with(question.section_key, 'bargaining-v1:')
  ) then
    raise exception 'a bargaining survey reports totals only' using errcode = '42501';
  end if;
  select pg_catalog.count(*)::integer into responses
  from private.survey_window_sessions(org, survey.id, p_from, p_to);
  -- The privacy floor applies to the responses inside the window: a narrow
  -- window can never release a group smaller than the floor.
  if responses < survey.privacy_min_responses then
    return pg_catalog.jsonb_build_object(
      'surveyId', survey.id, 'title', survey.title,
      'from', p_from, 'to', p_to,
      'responseCount', responses,
      'privacyMinResponses', survey.privacy_min_responses,
      'available', false,
      'questions', '[]'::jsonb
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'surveyId', survey.id,
    'title', survey.title,
    'from', p_from, 'to', p_to,
    'responseCount', responses,
    'privacyMinResponses', survey.privacy_min_responses,
    'available', true,
    'questions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', question.id,
        'label', question.label,
        'type', question.question_type,
        'answered', (
          select pg_catalog.count(*)
          from public.organization_survey_answers answer
          where answer.question_id = question.id
            and answer.session_id in (select private.survey_window_sessions(org, survey.id, p_from, p_to))
        ),
        'distribution', case
          when question.question_type in ('radio', 'dropdown', 'yes_no', 'scale', 'rating') then (
            select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('value', bucket.value, 'count', bucket.count) order by bucket.value), '[]'::jsonb)
            from (
              select answer.value, pg_catalog.count(*)::integer as count
              from public.organization_survey_answers answer
              where answer.question_id = question.id
                and answer.session_id in (select private.survey_window_sessions(org, survey.id, p_from, p_to))
              group by answer.value
            ) bucket
          )
          else '[]'::jsonb
        end
      ) order by question.sort_index)
      from public.organization_survey_questions question
      where question.survey_id = survey.id and question.organization_id = org
    ), '[]'::jsonb)
  );
end;
$function$;
revoke all on function public.get_organization_survey_report_window(uuid, timestamp with time zone, timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.get_organization_survey_report_window(uuid, timestamp with time zone, timestamp with time zone) to authenticated;

-- Platform export boundary: public.get_organization_survey_review_detail(uuid)
CREATE OR REPLACE FUNCTION public.get_organization_survey_review_detail(p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.engagement_selected_organization();
  target_survey uuid;
  lane jsonb;
begin
  perform private.engagement_require_staff(org);
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  select session.survey_id into target_survey
  from public.organization_survey_sessions session
  where session.id = p_session_id
    and session.organization_id = org
    and session.status = 'submitted';
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  lane := private.organization_survey_review_lane(org, target_survey);
  if lane ->> 'state' is distinct from 'ready' then
    return pg_catalog.jsonb_build_object(
      'sessionId', p_session_id,
      'surveyId', target_survey,
      'available', false,
      'state', 'collecting',
      'responseCount', (lane ->> 'responseCount')::integer,
      'privacyMinResponses', (lane ->> 'privacyMinResponses')::integer,
      'answers', '[]'::jsonb
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'sessionId', p_session_id,
    'surveyId', target_survey,
    'available', true,
    'state', 'ready',
    'responseCount', (lane ->> 'responseCount')::integer,
    'privacyMinResponses', (lane ->> 'privacyMinResponses')::integer,
    'answers', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'questionId', answer.question_id,
        'label', question.label,
        'type', question.question_type,
        'value', answer.value
      ) order by question.sort_index)
      from public.organization_survey_answers answer
      join public.organization_survey_questions question on question.id = answer.question_id
      where answer.session_id = p_session_id and answer.organization_id = org
    ), '[]'::jsonb)
  );
end;
$function$;
revoke all on function public.get_organization_survey_review_detail(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_organization_survey_review_detail(uuid) to authenticated;

-- Platform export boundary: public.get_organization_survey_worksites(uuid)
CREATE OR REPLACE FUNCTION public.get_organization_survey_worksites(p_survey_id uuid)
 RETURNS jsonb
 language plpgsql volatile security definer
 SET search_path TO ''
AS $function$
declare
  org uuid;
  survey public.organization_surveys%rowtype;
  result jsonb;
  current_signature text;
  released private.organization_survey_worksite_releases%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
  org := private.engagement_selected_organization();
  if auth.uid() is null or not private.has_organization_role(org, array['admin']) then
    raise exception 'organization admin required' using errcode = '42501';
  end if;
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  select * into survey from public.organization_surveys where id=p_survey_id and organization_id=org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  -- REQ-UG-BARGAINING-SURVEY-20261012: no worksite split of a
  -- bargaining survey; its totals come only from get_bargaining_survey_results.
  if exists (
    select 1 from public.organization_survey_questions question
    where question.survey_id = survey.id
      and pg_catalog.starts_with(question.section_key, 'bargaining-v1:')
  ) then
    raise exception 'a bargaining survey reports totals only' using errcode = '42501';
  end if;
  -- Serialize the first publication and comparisons for this survey. The
  -- digest and aggregates below share one statement snapshot, even if another
  -- transaction changes a profile, membership or answer during this request.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('worksite-release:' || survey.id::text, 0));
  select * into released from private.organization_survey_worksite_releases where survey_id=survey.id;
  if released.invalidated then
    return pg_catalog.jsonb_build_object('privacyMinResponses',survey.privacy_min_responses,
      'withheld',true,'releaseChanged',true,'groups','[]'::jsonb);
  end if;
  with sessions as materialized (
    select s.id,
      case when d.details_visibility='admins' then nullif(pg_catalog.btrim(d.worksite), '') end as site
    from public.organization_survey_sessions s
    left join public.member_profile_details d on d.user_id=s.respondent_user_id
      and exists (select 1 from public.organization_memberships m
        where m.user_id=s.respondent_user_id and m.organization_id=org and m.status='active')
      and exists (select 1 from public.member_chapter_memberships m
        join public.chapters c on c.id=m.chapter_id and c.organization_id=org
        where m.user_id=s.respondent_user_id and m.status='active')
    where s.organization_id=org and s.survey_id=survey.id and s.status='submitted'
  ), groups as materialized (
    select site, pg_catalog.count(*)::integer as n from sessions group by site
  ), hidden as (
    select * from groups where site is null or n < survey.privacy_min_responses
  ), visible as materialized (
    select * from groups g where g.site is not null and g.n >= survey.privacy_min_responses
      and (not exists (select 1 from hidden)
        or g.site <> (select g2.site from groups g2 where g2.site is not null
          and g2.n >= survey.privacy_min_responses order by g2.n, g2.site limit 1))
  ), cells as materialized (
    select q.id as question_id, s.site, a.value, pg_catalog.count(*)::integer as n
    from sessions s
    join public.organization_survey_answers a on a.session_id=s.id and a.organization_id=org
    join public.organization_survey_questions q on q.id=a.question_id
      and q.survey_id=survey.id and q.organization_id=org
    where q.question_type in ('radio','dropdown','yes_no','scale','rating')
    group by q.id, s.site, a.value
  ), unsafe as (
    select distinct c.question_id from cells c join groups g on g.site is not distinct from c.site
      where c.n < survey.privacy_min_responses
        or (g.n-c.n > 0 and g.n-c.n < survey.privacy_min_responses)
    union
    select q.id from public.organization_survey_questions q cross join groups g
      where q.survey_id=survey.id and q.organization_id=org
        and g.n - coalesce((select sum(c.n) from cells c where c.question_id=q.id
          and c.site is not distinct from g.site),0) between 1 and survey.privacy_min_responses-1
    union
    -- The largest cell has the smallest complement. If it is nonzero and
    -- small, hide the question everywhere, including sites with zero cells.
    select c.question_id from cells c group by c.question_id, c.value
      having sum(c.n)-max(c.n) between 1 and survey.privacy_min_responses-1
  )
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'minimum',survey.privacy_min_responses,
      'sessions',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(s.id,s.site) order by s.id) from sessions s),
      'answers',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.session_id,a.question_id,a.value) order by a.session_id,a.question_id)
        from public.organization_survey_answers a join sessions s on s.id=a.session_id
        where a.organization_id=org),
      'questions',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(q.id,q.question_type,q.label,q.sort_index) order by q.id)
        from public.organization_survey_questions q where q.survey_id=survey.id and q.organization_id=org)
    )::text, 'UTF8')), 'hex'), pg_catalog.jsonb_build_object(
    'privacyMinResponses',survey.privacy_min_responses,
    'withheld',exists(select 1 from groups g where not exists(select 1 from visible v where v.site=g.site)),
    'groups',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'worksite',v.site,'responseCount',v.n,
      'questions',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id',q.id,'label',q.label,
        'available',not exists(select 1 from unsafe u where u.question_id=q.id),
        'distribution',case when exists(select 1 from unsafe u where u.question_id=q.id) then '[]'::jsonb
          else coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('value',c.value,'count',c.n) order by c.value)
            from cells c where c.question_id=q.id and c.site=v.site),'[]'::jsonb) end
      ) order by q.sort_index) from public.organization_survey_questions q
        where q.survey_id=survey.id and q.organization_id=org
          and q.question_type in ('radio','dropdown','yes_no','scale','rating')),'[]'::jsonb)
    ) order by v.site) from visible v),'[]'::jsonb)
  ) into current_signature, result;
  if released.signature is not null and released.signature <> current_signature then
    update private.organization_survey_worksite_releases set invalidated=true where survey_id=survey.id;
    return pg_catalog.jsonb_build_object('privacyMinResponses',survey.privacy_min_responses,
      'withheld',true,'releaseChanged',true,'groups','[]'::jsonb);
  end if;
  -- An entirely suppressed response publishes no cohort counts. It must not
  -- prevent the first useful report after enough responses arrive.
  if released.signature is null and pg_catalog.jsonb_array_length(result->'groups') > 0 then
    insert into private.organization_survey_worksite_releases(survey_id,signature)
      values(survey.id,current_signature);
  end if;
  return result;
end;
$function$;
revoke all on function public.get_organization_survey_worksites(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_organization_survey_worksites(uuid) to authenticated;

-- Platform export boundary: public.request_digital_action_participant_export(text, uuid, text)
CREATE OR REPLACE FUNCTION public.request_digital_action_participant_export(p_selected_hat text, p_action_id uuid, p_participation_kind text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.mi1_require_selected_organization();
  action_title text;
  result_rows jsonb;
  result_count integer;
  receipt_id uuid;
  expires timestamptz := pg_catalog.now() + interval '24 hours';
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if p_selected_hat not in ('coordinator', 'admin', 'vp')
     or not private.has_organization_role(org, array[p_selected_hat]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if p_action_id is null or p_participation_kind not in ('signature', 'attendee', 'volunteer') then
    raise exception 'invalid export request' using errcode = '22023';
  end if;
  select a.title into action_title from public.digital_actions a
  where a.id = p_action_id and a.organization_id = org
  for share;
  if not found then raise exception 'digital action not found' using errcode = 'P0002'; end if;
  select pg_catalog.count(*)::integer into result_count
  from public.digital_action_participants p
  where p.organization_id = org and p.action_id = p_action_id
    and p.participation_kind = p_participation_kind;
  if result_count > 10000 then raise exception 'export row limit exceeded' using errcode = '54000'; end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'participationKind', p.participation_kind,
    'memberName', profile.full_name,
    'email', pg_catalog.lower(users.email),
    'chapterName', chapter.name,
    'joinedAt', p.joined_at
  ) order by profile.full_name, p.user_id), '[]'::jsonb) into result_rows
  from public.digital_action_participants p
  join public.member_profiles profile on profile.id = p.user_id
  join auth.users users on users.id = p.user_id
  left join public.chapters chapter
    on chapter.id = profile.chapter_id and chapter.organization_id = org
  where p.organization_id = org and p.action_id = p_action_id
    and p.participation_kind = p_participation_kind;
  delete from public.digital_action_exports receipt
  where receipt.organization_id = org and receipt.expires_at <= pg_catalog.now();
  insert into public.digital_action_exports (
    organization_id, action_id, participation_kind, row_count, created_by, expires_at
  ) values (
    org, p_action_id, p_participation_kind, result_count, (select auth.uid()), expires
  ) returning id into receipt_id;
  perform private.write_organization_intelligence_audit(
    org, 'digital_action_export_requested', 'digital_action_export', receipt_id::text,
    pg_catalog.jsonb_build_object(
      'participationKind', p_participation_kind, 'rowCount', result_count,
      'expiresAt', expires
    )
  );
  return pg_catalog.jsonb_build_object(
    'id', receipt_id, 'organizationId', org, 'actionId', p_action_id,
    'actionTitle', action_title, 'participationKind', p_participation_kind,
    'rowCount', result_count, 'expiresAt', expires, 'rows', result_rows
  );
end;
end;
$function$;
revoke all on function public.request_digital_action_participant_export(text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.request_digital_action_participant_export(text, uuid, text) to authenticated;

-- Platform export boundary: public.casework_record_case_export(uuid[], text, text[])
CREATE OR REPLACE FUNCTION public.casework_record_case_export(p_case_ids uuid[], p_scope text, p_filter_keys text[] DEFAULT '{}'::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_scope text;
  v_filters text[];
  v_count integer;
  v_readable integer;
  v_org uuid;
  v_org_count integer;
  v_chapter text;
  v_chapter_count integer;
  v_export_id uuid;
begin
  -- Case graph gate first, before any declaration initializer, authorization
  -- read or row acquisition: this routine writes public.casework_audit_events,
  -- which carries both an auth.users and a member_cases reference.
  perform private.lock_case_graph(array[(select auth.uid())], p_case_ids);
  perform private.casework_require_mfa();

  v_scope := pg_catalog.btrim(coalesce(p_scope, ''));
  if v_scope not in ('selection', 'visible') then
    raise exception 'export scope must be selection or visible' using errcode = '22023';
  end if;

  -- The count is derived, never asserted by the caller: the number in the audit
  -- row is the number of cases the caller had to name and pass the read gate
  -- for, so it cannot understate the export.
  --
  -- DISTINCT, because the read gate below counts distinct ids: counting the
  -- raw array would let a request with a repeated id record a rowCount above
  -- the number of cases that actually left the browser, and both caps would be
  -- measured against a number that is not the export's size either.
  select pg_catalog.count(distinct entry.id) into v_count
  from pg_catalog.unnest(coalesce(p_case_ids, '{}'::uuid[])) as entry(id);
  if v_count not between 1 and 500 then
    raise exception 'an export is limited to 500 cases' using errcode = '22023';
  end if;
  if v_scope = 'selection' and v_count > 100 then
    raise exception 'a selection export is limited to 100 cases' using errcode = '22023';
  end if;
  if pg_catalog.array_position(p_case_ids, null) is not null then
    raise exception 'export case ids must not be null' using errcode = '22023';
  end if;

  -- Closed vocabulary of facet NAMES. The facet's value never travels.
  v_filters := coalesce(p_filter_keys, '{}'::text[]);
  if pg_catalog.cardinality(v_filters) > 6 then
    raise exception 'export filter keys are not recognized' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_catalog.unnest(v_filters) as entry(key)
    where entry.key is null
      or entry.key not in ('step', 'caseType', 'assignee', 'deadline', 'status', 'chapter')
  ) then
    raise exception 'export filter keys are not recognized' using errcode = '22023';
  end if;

  -- The shared staff predicate, applied to every id. Distinct ids are counted
  -- so a repeated id cannot stand in for one the actor may not read.
  select pg_catalog.count(distinct c.id), pg_catalog.count(distinct c.organization_id),
         pg_catalog.count(distinct c.chapter_id)
    into v_readable, v_org_count, v_chapter_count
  from public.member_cases c
  where c.id = any(p_case_ids)
    and private.casework_staff_can_access(c.id);
  if v_readable <> v_count then
    raise exception 'export selection is not authorized' using errcode = 'P0002';
  end if;
  -- One tenant per export, exactly as casework_apply_macro requires: the audit
  -- row carries one organization_id, so a cross-organization export could not
  -- be recorded honestly in a single row.
  if v_org_count <> 1 then
    raise exception 'an export covers one organization' using errcode = '22023';
  end if;
  -- One row is enough: v_org_count has already proved the tenant is unique.
  select c.organization_id into v_org
  from public.member_cases c where c.id = any(p_case_ids) limit 1;
  if not private.organization_is_union(v_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  -- chapter_id is left null when the export spans chapters rather than naming
  -- one of them arbitrarily.
  if v_chapter_count = 1 then
    select c.chapter_id into v_chapter
    from public.member_cases c where c.id = any(p_case_ids) and c.chapter_id is not null limit 1;
  end if;

  v_export_id := extensions.gen_random_uuid();
  -- case_id stays null: an export is not an event on one case, and the
  -- composite member_cases reference is satisfied by the null key. The row is
  -- therefore readable by an organization coordinator who is not authorized for
  -- every exported case, so a selection records one salted digest per case id
  -- rather than the id itself: a reader who already holds a case id can prove
  -- the case was in this export, and a reader who does not learns nothing. A
  -- visible-slice export records its facets and its count.
  insert into public.casework_audit_events(
    organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_org, v_chapter, null, (select auth.uid()),
    'cases_exported', 'case_export', v_export_id,
    pg_catalog.jsonb_build_object(
      'scope', v_scope,
      'rowCount', v_count,
      'filterKeys', pg_catalog.to_jsonb(v_filters))
    || (case when v_scope = 'selection'
          then pg_catalog.jsonb_build_object('caseIdDigests',
                 (select pg_catalog.jsonb_agg(distinct pg_catalog.left(
                    pg_catalog.encode(
                      extensions.digest(v_export_id::text || ':' || entry.id::text, 'sha256'),
                      'hex'), 32))
                  from pg_catalog.unnest(p_case_ids) as entry(id)))
          else '{}'::jsonb end));

  return pg_catalog.jsonb_build_object(
    'exportId', v_export_id, 'scope', v_scope, 'rowCount', v_count,
    'limit', 500, 'selectionLimit', 100);
end;
$function$;
revoke all on function public.casework_record_case_export(uuid[], text, text[]) from public, anon, authenticated, service_role;
grant execute on function public.casework_record_case_export(uuid[], text, text[]) to authenticated;

-- Platform export boundary: public.get_ballot_tally(text)
CREATE OR REPLACE FUNCTION public.get_ballot_tally(p_ballot_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  ballot record;
  total integer;
  option_counts jsonb;
begin
  if caller is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select id, organization_id, title, closes_at, active, quorum_target, campaign_state into ballot
  from public.member_ballots
  where id = p_ballot_id and campaign_state <> 'draft'
    and private.can_read_vote_campaign(organization_id, chapter_id);
  if not found then raise exception 'ballot not found' using errcode = '22023'; end if;
  if private.organization_is_platform(ballot.organization_id) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  select count(*) into total from public.member_ballot_choices where ballot_id = ballot.id;
  -- Publication gate = exact complement of submit_ballot_vote's refusal
  -- ("if not ballot.active or ballot.closes_at <= now() then raise exception
  -- 'this ballot is closed'"): the moment a vote can no longer be cast, the
  -- counts are readable — no staff close required.
  if not ballot.active or ballot.closes_at <= now() then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'optionId', counts.option_id, 'label', counts.label, 'labelEs', counts.label_es,
      'votes', counts.votes) order by counts.order_index), '[]'::jsonb)
    into option_counts
    from (
      select options.id as option_id, options.label, options.label_es, options.order_index,
        count(choices.option_id) as votes
      from public.member_ballot_options options
      left join public.member_ballot_choices choices
        on choices.ballot_id = options.ballot_id and choices.option_id = options.id
      where options.ballot_id = ballot.id
      group by options.id, options.label, options.label_es, options.order_index
    ) counts;
  end if;
  return pg_catalog.jsonb_build_object('ballotId', ballot.id, 'totalVotes', total,
    'quorumTarget', ballot.quorum_target, 'closesAt', ballot.closes_at,
    'active', ballot.active, 'options', option_counts);
end;
$function$;
revoke all on function public.get_ballot_tally(text) from public, anon, authenticated, service_role;
grant execute on function public.get_ballot_tally(text) to authenticated;

-- Platform export boundary: public.get_channel_poll_tally(uuid)
CREATE OR REPLACE FUNCTION public.get_channel_poll_tally(p_poll_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  poll public.chapter_channel_polls;
  options jsonb;
  total integer;
  mine uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select p.* into poll
  from public.chapter_channel_polls p
  join public.chapter_spaces s on s.id = p.space_id
  where p.id = p_poll_id and private.can_read_chapter_space(s);
  if poll.id is null then
    raise exception 'poll unavailable' using errcode = '22023';
  end if;
  if private.chapter_belongs_to_platform(poll.chapter_id) then
    -- Voting returns this tally in the same transaction. Withhold aggregate
    -- counts without throwing away the member's cast, changed or cleared vote.
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', o.id, 'label', o.label, 'position', o.position, 'votes', null)
      order by o.position), '[]'::jsonb)
    into options from public.chapter_channel_poll_options o where o.poll_id = p_poll_id;
    select v.option_id into mine from public.chapter_channel_poll_votes v
      where v.poll_id = p_poll_id and v.user_id = caller;
    return pg_catalog.jsonb_build_object(
      'poll_id', poll.id, 'question', poll.question, 'closes_at', poll.closes_at,
      'total', null, 'mine', mine, 'options', options);
  end if;

  select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('id', o.id, 'label', o.label, 'position', o.position, 'votes', coalesce(counts.votes, 0))
      order by o.position), '[]'::jsonb)
    into options
  from public.chapter_channel_poll_options o
  left join (
    select v.option_id, pg_catalog.count(*)::integer as votes
    from public.chapter_channel_poll_votes v
    where v.poll_id = p_poll_id
    group by v.option_id
  ) counts on counts.option_id = o.id
  where o.poll_id = p_poll_id;

  select pg_catalog.count(*)::integer into total
  from public.chapter_channel_poll_votes v where v.poll_id = p_poll_id;

  select v.option_id into mine
  from public.chapter_channel_poll_votes v
  where v.poll_id = p_poll_id and v.user_id = caller;

  return pg_catalog.jsonb_build_object(
    'poll_id', poll.id,
    'question', poll.question,
    'closes_at', poll.closes_at,
    'total', total,
    'mine', mine,
    'options', options);
end;
$function$;
revoke all on function public.get_channel_poll_tally(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_channel_poll_tally(uuid) to authenticated;

-- Platform export boundary: public.chapter_task_report(date, date)
CREATE OR REPLACE FUNCTION public.chapter_task_report(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  range_from date;
  range_to date;
  result jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;

  if caller_chapter is null then
    raise exception 'member chapter required' using errcode = '42501';
  end if;
  if private.chapter_belongs_to_platform(caller_chapter) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  -- Default window is all of it. A null bound means unbounded on that side;
  -- the caller decides, and the UI names whatever it asked for.
  range_from := coalesce(p_from, '2000-01-01'::date);
  range_to := coalesce(p_to, current_date);

  if range_to < range_from then
    raise exception 'report range is inverted' using errcode = '22023';
  end if;

  with scoped as (
    select t.*
    from public.chapter_tasks t
    where t.chapter_id = caller_chapter
      and t.deleted_at is null
      and t.created_at::date <= range_to
      and (t.done_at is null or t.done_at::date between range_from and range_to)
      and (t.due_date is null or t.done_at::date between range_from and range_to or t.due_date >= range_from)
  ),
  totals as (
    select
      pg_catalog.count(*) as total,
      pg_catalog.count(*) filter (where status = 'done') as done,
      pg_catalog.count(*) filter (where status <> 'done') as open,
      pg_catalog.count(*) filter (where blocked) as blocked,
      pg_catalog.count(*) filter (where status <> 'done' and due_date is not null and due_date < current_date) as overdue,
      pg_catalog.count(*) filter (where milestone) as milestones,
      -- Cycle time in whole days, median rather than mean: one task that sat
      -- for a year would otherwise describe the whole chapter.
      pg_catalog.percentile_cont(0.5) within group (
        order by extract(epoch from (done_at - created_at)) / 86400.0
      ) filter (where done_at is not null) as median_days_to_done,
      -- Delivery honesty: of the work that finished, how much finished late.
      pg_catalog.count(*) filter (where done_at is not null and due_date is not null and done_at::date > due_date) as done_late
    from scoped
  ),
  by_month as (
    select pg_catalog.to_char(pg_catalog.date_trunc('month', done_at), 'YYYY-MM') as month,
           pg_catalog.count(*) as done
    from scoped
    where done_at is not null
    group by 1
    order by 1
  ),
  by_workstream as (
    select workstream as name,
           pg_catalog.count(*) as total,
           pg_catalog.count(*) filter (where status = 'done') as done,
           pg_catalog.count(*) filter (where blocked) as blocked
    from scoped
    group by 1
    order by 2 desc, 1
  ),
  by_person as (
    -- assignee_name, not assignee_id: this is a report, and a member who has
    -- left the chapter still did the work. Unassigned is its own row.
    select coalesce(nullif(assignee_name, ''), '—') as name,
           pg_catalog.count(*) as total,
           pg_catalog.count(*) filter (where status = 'done') as done,
           pg_catalog.count(*) filter (where status <> 'done' and due_date is not null and due_date < current_date) as overdue
    from scoped
    group by 1
    order by 2 desc, 1
  ),
  removed as (
    select pg_catalog.count(*) as deleted_count
    from public.chapter_tasks t
    where t.chapter_id = caller_chapter
      and t.deleted_at is not null
      and t.deleted_at::date between range_from and range_to
  )
  select pg_catalog.jsonb_build_object(
    'chapterId', caller_chapter,
    'from', range_from,
    'to', range_to,
    'generatedAt', now(),
    'totals', (select pg_catalog.to_jsonb(totals) from totals),
    'deletedCount', (select deleted_count from removed),
    'byMonth', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(by_month)) from by_month), '[]'::jsonb),
    'byWorkstream', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(by_workstream)) from by_workstream), '[]'::jsonb),
    'byPerson', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(by_person)) from by_person), '[]'::jsonb)
  ) into result;

  return result;
end
$function$;
revoke all on function public.chapter_task_report(date, date) from public, anon, authenticated, service_role;
grant execute on function public.chapter_task_report(date, date) to authenticated;

-- Platform export boundary: public.get_vp_overview()
CREATE OR REPLACE FUNCTION public.get_vp_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid;
  caller_chapter text;
  member_count integer;
  new_this_year integer;
  active_grievances integer;
  turnout jsonb;
  attention jsonb;
  upcoming jsonb;
  priorities jsonb;
  trend jsonb;
begin
  if caller is null or not public.member_has_role(array['vp', 'admin']) then
    raise exception 'vp role required' using errcode = '42501';
  end if;

  -- Fail closed: no selected organization or chapter means no tenant to
  -- report on, never a database-wide scan.
  caller_org := private.current_member_organization();
  caller_chapter := private.current_member_chapter();
  if caller_org is null or caller_chapter is null then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if not private.organization_is_union(caller_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  select
    pg_catalog.count(*),
    pg_catalog.count(*) filter (where p.member_since = pg_catalog.date_part('year', pg_catalog.now())::int)
  into member_count, new_this_year
  from public.member_profiles p
  where p.chapter_id = caller_chapter;

  select pg_catalog.count(*)
  into active_grievances
  from public.member_cases c
  where c.status = 'active'
    and c.organization_id is not null
    and c.chapter_id is not null
    and c.organization_id = caller_org
    and c.chapter_id = caller_chapter;

  select pg_catalog.jsonb_build_object(
      'title', b.title,
      'totalVotes', v.n,
      'quorumTarget', b.quorum_target)
  into turnout
  from public.member_ballots b
  left join lateral (
    select pg_catalog.count(*) as n
    from public.member_ballot_choices
    where ballot_id = b.id
  ) v on true
  where (b.active = false or b.closes_at < pg_catalog.now())
    and b.campaign_state <> 'draft'
    and b.organization_id = caller_org
    and (b.chapter_id is null or b.chapter_id = caller_chapter)
  order by b.closes_at desc
  limit 1;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', s.id,
      'reference', s.reference,
      'title', s.title,
      'step', s.step,
      'deadline', s.deadline,
      'memberName', s.member_name)), '[]'::jsonb)
  into attention
  from (
    select c.id, c.reference, c.title, c.step, c.deadline, p.full_name as member_name
    from public.member_cases c
    join public.member_profiles p on p.id = c.user_id
    where c.status = 'active'
      and c.deadline is not null
      and c.deadline < current_date
      and c.organization_id is not null
      and c.chapter_id is not null
      and c.organization_id = caller_org
      and c.chapter_id = caller_chapter
    order by c.deadline
    limit 6
  ) s;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.id,
      'title', e.title,
      'startsAt', e.starts_at,
      'location', e.location,
      'summary', e.summary)), '[]'::jsonb)
  into upcoming
  from (
    select ev.id, ev.title, ev.starts_at, ev.location, ev.summary
    from public.member_events ev
    join public.chapters event_chapter
      on event_chapter.id = ev.chapter_id
     and event_chapter.organization_id = caller_org
    where ev.starts_at >= pg_catalog.now()
      and ev.cancelled_at is null
      and private.member_can_access_event_scope(ev.chapter_id, ev.is_public, ev.is_public_across_agencies)
    order by ev.starts_at
    limit 5
  ) e;

  -- The aggregate-level ORDER BY is the guarantee; the subquery's ORDER BY
  -- only picks WHICH 8 survive the limit.
  select coalesce(pg_catalog.jsonb_agg(x.obj order by x.order_index), '[]'::jsonb)
  into priorities
  from (
    select pg_catalog.jsonb_build_object('id', id, 'title', title, 'kind', 'ballot') as obj, order_index
    from public.member_ballots
    where active = true
      and campaign_state <> 'draft'
      and organization_id = caller_org
      and (chapter_id is null or chapter_id = caller_chapter)
    union all
    select pg_catalog.jsonb_build_object('id', id, 'title', title, 'kind', 'survey'), order_index
    from public.member_surveys
    where active = true
      and campaign_state <> 'draft'
      and organization_id = caller_org
      and (chapter_id is null or chapter_id = caller_chapter)
    order by order_index
    limit 8
  ) x;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'year', y.yr, 'count', y.cumulative) order by y.yr), '[]'::jsonb)
  into trend
  from (
    select g.yr, pg_catalog.sum(g.n) over (order by g.yr) as cumulative
    from (
      select p.member_since as yr, pg_catalog.count(*) as n
      from public.member_profiles p
      where p.chapter_id = caller_chapter
      group by p.member_since
    ) g
  ) y
  where y.yr >= pg_catalog.date_part('year', pg_catalog.now())::int - 5;

  return pg_catalog.jsonb_build_object(
    'memberCount', member_count,
    'newThisYear', new_this_year,
    'activeGrievances', active_grievances,
    'turnout', turnout,
    'attention', attention,
    'upcomingEvents', upcoming,
    'priorities', priorities,
    'membershipTrend', trend);
end;
$function$;
revoke all on function public.get_vp_overview() from public, anon, authenticated, service_role;
grant execute on function public.get_vp_overview() to authenticated;

-- Platform export boundary: public.get_advisor_overview()
CREATE OR REPLACE FUNCTION public.get_advisor_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  caller_org uuid := private.current_member_organization();
  members_covered integer;
  open_cases integer;
  resolved_cases integer;
  overdue_cases integer;
  steward_count integer;
  turnout jsonb;
begin
  if caller is null or not public.member_has_role(array['advisor', 'admin']) then
    raise exception 'advisor role required' using errcode = '42501';
  end if;
  -- A legacy advisor on an ownerless chapter resolves no organization; only a
  -- platform caller is refused, and only platform-owned rows leave the totals.
  if private.organization_is_platform(caller_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  select r.chapter_id into caller_chapter
  from public.member_roles r
  where r.user_id = caller and r.role in ('advisor', 'admin')
  order by case r.role when 'advisor' then 0 else 1 end
  limit 1;

  select pg_catalog.count(*)
  into members_covered
  from public.member_profiles p
  where (caller_chapter is null or p.chapter_id = caller_chapter)
    and not private.chapter_belongs_to_platform(p.chapter_id);

  with base as materialized (
    select c.status, c.deadline
    from public.member_cases c
    join public.member_profiles p on p.id = c.user_id
    where (caller_chapter is null or p.chapter_id = caller_chapter)
    and not private.organization_is_platform(c.organization_id)
  )
  select
    pg_catalog.count(*) filter (where b.status = 'active'),
    pg_catalog.count(*) filter (where b.status = 'resolved'),
    pg_catalog.count(*) filter (where b.status = 'active'
      and b.deadline is not null
      and b.deadline < current_date)
  into open_cases, resolved_cases, overdue_cases
  from base b;

  -- An org-wide steward (NULL chapter role row) covers every chapter, so it
  -- counts toward any caller's scope.
  select pg_catalog.count(distinct r.user_id)
  into steward_count
  from public.member_roles r
  where r.role = 'steward'
    and not private.chapter_belongs_to_platform(r.chapter_id)
    and (exists (select 1 from public.organization_memberships m
        where m.user_id = r.user_id and m.status = 'active' and private.organization_is_union(m.organization_id))
      or not exists (select 1 from public.organization_memberships m
        where m.user_id = r.user_id and m.status = 'active' and private.organization_is_platform(m.organization_id)))
    and (caller_chapter is null or r.chapter_id is null or r.chapter_id = caller_chapter);

  select pg_catalog.jsonb_build_object(
      'title', b.title,
      'totalVotes', v.n,
      'quorumTarget', b.quorum_target)
  into turnout
  from public.member_ballots b
  left join lateral (
    select pg_catalog.count(*) as n
    from public.member_ballot_choices
    where ballot_id = b.id
  ) v on true
  where (b.active = false or b.closes_at < pg_catalog.now())
    and not private.organization_is_platform(b.organization_id)
  order by b.closes_at desc
  limit 1;

  return pg_catalog.jsonb_build_object(
    'membersCovered', members_covered,
    'openGrievances', open_cases,
    'resolvedGrievances', resolved_cases,
    'stewardCount', steward_count,
    'coverageRatio', case when steward_count = 0 then null
      else pg_catalog.round(members_covered::numeric / steward_count) end,
    'resolutionRate', case when open_cases + resolved_cases = 0 then null
      else pg_catalog.round(100.0 * resolved_cases / (open_cases + resolved_cases)) end,
    'turnout', turnout,
    'atRisk', pg_catalog.jsonb_build_object(
      'overdueCases', overdue_cases,
      'unstaffed', steward_count = 0));
end;
$function$;
revoke all on function public.get_advisor_overview() from public, anon, authenticated, service_role;
grant execute on function public.get_advisor_overview() to authenticated;

-- Platform export boundary: public.get_officer_removal_ballot_details(text[])
CREATE OR REPLACE FUNCTION public.get_officer_removal_ballot_details(p_ballot_ids text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  items jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if private.organization_is_platform(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if p_ballot_ids is null or pg_catalog.cardinality(p_ballot_ids) > 200 then
    raise exception 'invalid ballot ids' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'ballotId', b.id,
      'targetUserId', case when b.manageable then b.target_officer_id end,
      'targetName', b.target_officer_name,
      'targetRole', b.target_officer_role,
      'reason', b.removal_reason,
      'outcome', b.removal_outcome,
      'outcomeRecordedAt', b.removal_outcome_recorded_at,
      'canRecordOutcome', manageable and b.removal_outcome is null and b.target_officer_id is not null
        and (b.campaign_state = 'closed' or (b.campaign_state = 'open' and b.closes_at <= pg_catalog.now()))
    ) order by b.id), '[]'::jsonb)
  into items
  from (
    select ballot.*, private.can_manage_vote_campaign(ballot.organization_id, ballot.chapter_id) as manageable
    from public.member_ballots ballot
    where ballot.id = any(p_ballot_ids) and ballot.ballot_type = 'officer_removal'
      and not private.organization_is_platform(ballot.organization_id)
  ) b
  where b.manageable
     or (b.campaign_state <> 'draft' and private.can_read_vote_campaign(b.organization_id, b.chapter_id));

  return pg_catalog.jsonb_build_object(
    'enabled', org is not null and private.organization_feature_enabled(org, 'features.governance.officer_removal_ballots'),
    'items', items);
end;
$function$;
revoke all on function public.get_officer_removal_ballot_details(text[]) from public, anon, authenticated, service_role;
grant execute on function public.get_officer_removal_ballot_details(text[]) to authenticated;

-- Platform export boundary: public.verify_ballot_receipt(text)
CREATE OR REPLACE FUNCTION public.verify_ballot_receipt(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  clean_code text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_code, '')));
  receipt record;
begin
  if clean_code !~ '^SG-[0-9A-HJ-KM-NP-TV-Z]{4}-[0-9A-HJ-KM-NP-TV-Z]{4}$' then
    return pg_catalog.jsonb_build_object('found', false);
  end if;

  select receipts.counted, receipts.issued_at, ballots.title into receipt
  from public.member_ballot_receipts as receipts
  join public.member_ballots as ballots on ballots.id = receipts.ballot_id
  where receipts.receipt_code = clean_code
    and not private.organization_is_platform(ballots.organization_id);


  if not found then
    return pg_catalog.jsonb_build_object('found', false);
  end if;

  return pg_catalog.jsonb_build_object(
    'found', true,
    'ballotTitle', receipt.title,
    'counted', receipt.counted,
    'issuedAt', receipt.issued_at
  );
end;
$function$;
revoke all on function public.verify_ballot_receipt(text) from public, anon, authenticated, service_role;
grant execute on function public.verify_ballot_receipt(text) to authenticated, anon;

-- Platform export boundary: private.organization_export_dataset(uuid, text)
CREATE OR REPLACE FUNCTION private.organization_export_dataset(p_organization_id uuid, p_dataset text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  result_columns text[];
  result_rows jsonb;
begin
  if not private.organization_is_union(p_organization_id) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  case p_dataset
    when 'coordination_records' then
      result_columns := array['id', 'kind', 'title', 'status', 'visibility', 'updated_at'];
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        x.id, x.kind, x.title, x.status, x.visibility, x.updated_at
      ) order by x.updated_at desc, x.id desc), '[]'::jsonb) into result_rows
      from (
        select record.id, record.kind, record.title, record.status, record.visibility, record.updated_at
        from public.organization_coordination_records record
        where private.organization_is_union(record.organization_id)
      and (record.organization_id = p_organization_id
          or exists (
            select 1
            from public.organization_coordination_organization_participants participant
            where participant.record_id = record.id
              and participant.organization_id = p_organization_id
              and participant.status = 'active'
          ))
        order by record.updated_at desc, record.id desc
        limit 10000
      ) x;
    when 'members_directory' then
      -- Old DATASET_COLUMNS.members_directory: name, role and branch only. No
      -- email, phone, address or employee identifier.
      result_columns := array['name', 'role', 'chapter'];
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        x.full_name, x.role, x.chapter_name
      ) order by x.full_name, x.user_id), '[]'::jsonb) into result_rows
      from (
        select p.id as user_id, p.full_name,
          coalesce((
            select g.role from public.organization_role_grants g
            where g.organization_id = p_organization_id and g.user_id = p.id
            order by pg_catalog.array_position(array['vp','admin','coordinator','advisor','steward']::text[], g.role)
            limit 1
          ), 'member') as role,
          membership.chapter_name
        from public.organization_memberships om
        join public.member_profiles p on p.id = om.user_id
        join lateral (
          select c.name as chapter_name
          from public.member_chapter_memberships cm
          join public.chapters c on c.id = cm.chapter_id
          where cm.user_id = p.id and cm.status = 'active' and c.organization_id = p_organization_id
          order by (cm.chapter_id = p.chapter_id) desc, cm.chapter_id
          limit 1
        ) membership on true
        where om.organization_id = p_organization_id and om.status = 'active'
        order by p.full_name, p.id
        limit 10000
      ) x;
    when 'events' then
      -- check_in_code is a secret and never leaves the database.
      result_columns := array['id', 'title', 'starts_at', 'location', 'chapter', 'public', 'public_across_agencies', 'cancelled_at', 'created_at'];
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        x.id, x.title, x.starts_at, x.location, x.chapter_name, x.is_public,
        x.is_public_across_agencies, x.cancelled_at, x.created_at
      ) order by x.starts_at desc, x.id), '[]'::jsonb) into result_rows
      from (
        select e.id, e.title, e.starts_at, e.location, c.name as chapter_name, e.is_public,
          e.is_public_across_agencies, e.cancelled_at, e.created_at
        from public.member_events e
        join public.chapters c on c.id = e.chapter_id
        where c.organization_id = p_organization_id
        order by e.starts_at desc, e.id
        limit 10000
      ) x;
    when 'resources' then
      result_columns := array['id', 'title', 'category', 'summary', 'file_name', 'visibility', 'created_at'];
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        x.id, x.title, x.category, x.summary, x.file_name, x.visibility, x.created_at
      ) order by x.created_at desc, x.id), '[]'::jsonb) into result_rows
      from (
        select f.id, f.title, f.category, f.summary, f.file_name, f.visibility, f.created_at
        from public.organization_knowledge_files f
        where f.organization_id = p_organization_id
          and f.published_to_catalog
          and f.review_status = 'approved'
        order by f.created_at desc, f.id
        limit 10000
      ) x;
    when 'knowledge_articles' then
      result_columns := array['id', 'title', 'kind', 'reference', 'status', 'chapter', 'created_at', 'updated_at'];
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        x.id, x.title, x.kind, x.article_ref, x.status, x.chapter_name, x.created_at, x.updated_at
      ) order by x.updated_at desc, x.id), '[]'::jsonb) into result_rows
      from (
        select k.id, k.title, k.kind, k.article_ref, k.status, c.name as chapter_name, k.created_at, k.updated_at
        from public.member_kb_articles k
        join public.chapters c on c.id = k.chapter_id
        where c.organization_id = p_organization_id
          and not k.is_sample
          and k.status in ('draft', 'published')
          and k.content_origin <> 'unresolved'
        order by k.updated_at desc, k.id
        limit 10000
      ) x;
    when 'broadcast_log' then
      result_columns := array['id', 'title', 'sender', 'audience', 'chapter', 'published_at', 'retracted_at'];
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        x.id, x.title, x.sender, x.audience_scope, x.chapter_name, x.published_at, x.retracted_at
      ) order by x.published_at desc, x.id), '[]'::jsonb) into result_rows
      from (
        select b.id, b.title, b.sender, b.audience_scope, c.name as chapter_name, b.published_at, b.retracted_at
        from public.member_broadcasts b
        left join public.chapters c on c.id = b.chapter_id
        where b.organization_id = p_organization_id
        order by b.published_at desc, b.id
        limit 10000
      ) x;
    else
      raise exception 'export dataset unavailable' using errcode = '22023';
  end case;
  return pg_catalog.jsonb_build_object('columns', pg_catalog.to_jsonb(result_columns), 'rows', result_rows);
end;
$function$;
revoke all on function private.organization_export_dataset(uuid, text) from public, anon, authenticated, service_role;

-- Platform export boundary: public.run_organization_coordination_export(uuid, text, uuid)
CREATE OR REPLACE FUNCTION public.run_organization_coordination_export(p_schedule_id uuid, p_format text DEFAULT 'csv'::text, p_idempotency_key uuid DEFAULT extensions.gen_random_uuid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  run_id uuid;
  rows_ready integer;
  chosen text;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.has_organization_role(organization, array['coordinator','admin','vp']) then
    raise exception 'organization export role required' using errcode = '42501';
  end if;
  if not private.organization_is_union(organization) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if p_format not in ('csv', 'json') then
    raise exception 'export format unavailable' using errcode = '22023';
  end if;
  select coalesce(record.config ->> 'dataset', 'coordination_records') into chosen
  from public.organization_coordination_records record
  where record.id = p_schedule_id and record.organization_id = organization
    and record.kind = 'network_export_schedule' and record.status = 'active';
  if not found then
    raise exception 'export schedule unavailable' using errcode = '22023';
  end if;
  if not private.has_organization_role(organization, private.organization_export_dataset_roles(chosen)) then
    raise exception 'organization export role required' using errcode = '42501';
  end if;
  if private.organization_export_restored_dataset(chosen)
     and not private.organization_feature_enabled(organization, 'features.automation.scheduled_dataset_exports') then
    raise exception 'scheduled dataset exports are turned off for this organization' using errcode = '42501';
  end if;
  if chosen = 'coordination_records' then
    select pg_catalog.count(*)::integer into rows_ready
    from public.organization_coordination_records record
    where private.organization_is_union(record.organization_id)
      and (record.organization_id = organization
      or exists (
        select 1
        from public.organization_coordination_organization_participants participant
        where participant.record_id = record.id
          and participant.organization_id = organization
          and participant.status = 'active'
      ));
  else
    rows_ready := pg_catalog.jsonb_array_length(private.organization_export_dataset(organization, chosen) -> 'rows');
  end if;
  insert into public.organization_coordination_export_runs (
    schedule_id, organization_id, requested_by, format, delivery_mode,
    status, row_count, idempotency_key, dataset
  ) values (
    p_schedule_id, organization, caller, p_format, 'internal_download',
    'ready', rows_ready, p_idempotency_key, chosen
  ) on conflict (idempotency_key) do update
    set idempotency_key = excluded.idempotency_key
  returning id into run_id;
  return pg_catalog.jsonb_build_object(
    'runId', run_id, 'status', 'ready', 'rowCount', rows_ready,
    'deliveryMode', 'internal_download', 'dataset', chosen
  );
end;
end;
$function$;
revoke all on function public.run_organization_coordination_export(uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.run_organization_coordination_export(uuid, text, uuid) to authenticated;

-- Platform export boundary: public.get_organization_coordination_export_payload(uuid)
CREATE OR REPLACE FUNCTION public.get_organization_coordination_export_payload(p_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  export_run public.organization_coordination_export_runs%rowtype;
  content text;
  dataset_table jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.has_organization_role(organization, array['coordinator','admin','vp']) then
    raise exception 'organization export role required' using errcode = '42501';
  end if;
  if not private.organization_is_union(organization) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  select * into export_run
  from public.organization_coordination_export_runs run
  where run.id = p_run_id and run.organization_id = organization
    and (
      (run.delivery_mode = 'internal_download' and run.status = 'ready')
      or (run.delivery_mode in ('email_unset', 'sftp_unset') and run.status in ('delivered', 'not_configured'))
    )
    and run.expires_at > pg_catalog.now();
  if not found then
    raise exception 'ready organization export unavailable' using errcode = '22023';
  end if;
  if not private.has_organization_role(organization, private.organization_export_dataset_roles(export_run.dataset)) then
    raise exception 'organization export role required' using errcode = '42501';
  end if;
  if private.organization_export_restored_dataset(export_run.dataset)
     and not private.organization_feature_enabled(organization, 'features.automation.scheduled_dataset_exports') then
    raise exception 'scheduled dataset exports are turned off for this organization' using errcode = '42501';
  end if;

  dataset_table := private.organization_export_dataset(organization, export_run.dataset);

  if export_run.dataset = 'coordination_records' and export_run.format = 'json' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', record.id,
      'kind', record.kind,
      'title', record.title,
      'status', record.status,
      'visibility', record.visibility,
      'updatedAt', record.updated_at
    ) order by record.updated_at desc, record.id desc), '[]'::jsonb)::text
    into content
    from public.organization_coordination_records record
    where private.organization_is_union(record.organization_id)
      and (record.organization_id = organization
      or exists (
        select 1
        from public.organization_coordination_organization_participants participant
        where participant.record_id = record.id
          and participant.organization_id = organization
          and participant.status = 'active'
      ));
  elsif export_run.dataset = 'coordination_records' then
    select 'id,kind,title,status,visibility,updated_at' || pg_catalog.chr(10)
      || coalesce(pg_catalog.string_agg(
        private.organization_coordination_csv_cell(record.id::text) || ','
        || private.organization_coordination_csv_cell(record.kind) || ','
        || private.organization_coordination_csv_cell(record.title) || ','
        || private.organization_coordination_csv_cell(record.status) || ','
        || private.organization_coordination_csv_cell(record.visibility) || ','
        || private.organization_coordination_csv_cell(record.updated_at::text),
        pg_catalog.chr(10) order by record.updated_at desc, record.id desc
      ), '')
    into content
    from public.organization_coordination_records record
    where private.organization_is_union(record.organization_id)
      and (record.organization_id = organization
      or exists (
        select 1
        from public.organization_coordination_organization_participants participant
        where participant.record_id = record.id
          and participant.organization_id = organization
          and participant.status = 'active'
      ));
  elsif export_run.format = 'json' then
    select coalesce(pg_catalog.jsonb_agg((
      select pg_catalog.jsonb_object_agg(col.name, row_value.value -> (col.position::integer - 1))
      from pg_catalog.jsonb_array_elements_text(dataset_table -> 'columns') with ordinality as col(name, position)
    ) order by row_value.ordinality), '[]'::jsonb)::text
    into content
    from pg_catalog.jsonb_array_elements(dataset_table -> 'rows') with ordinality as row_value(value, ordinality);
  else
    select (
      select pg_catalog.string_agg(private.organization_coordination_csv_cell(col.name), ',' order by col.position)
      from pg_catalog.jsonb_array_elements_text(dataset_table -> 'columns') with ordinality as col(name, position)
    ) || pg_catalog.chr(10) || coalesce((
      select pg_catalog.string_agg((
        select pg_catalog.string_agg(private.organization_coordination_csv_cell(cell.value), ',' order by cell.position)
        from pg_catalog.jsonb_array_elements_text(row_value.value) with ordinality as cell(value, position)
      ), pg_catalog.chr(10) order by row_value.ordinality)
      from pg_catalog.jsonb_array_elements(dataset_table -> 'rows') with ordinality as row_value(value, ordinality)
    ), '')
    into content;
  end if;

  return pg_catalog.jsonb_build_object(
    'runId', export_run.id,
    'dataset', export_run.dataset,
    'filename', case when export_run.dataset = 'coordination_records'
        then 'coordination-export-' else pg_catalog.replace(export_run.dataset, '_', '-') || '-export-' end
      || pg_catalog.to_char(export_run.created_at at time zone 'UTC', 'YYYYMMDDHH24MISS')
      || '.' || export_run.format,
    'mimeType', case when export_run.format = 'json'
      then 'application/json' else 'text/csv' end,
    'content', content,
    'rowCount', export_run.row_count,
    'table', dataset_table
  );
end;

end;
$function$;
revoke all on function public.get_organization_coordination_export_payload(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_organization_coordination_export_payload(uuid) to authenticated;

-- Platform export boundary: public.run_due_organization_coordination_exports(timestamp with time zone, integer)
CREATE OR REPLACE FUNCTION public.run_due_organization_coordination_exports(p_now timestamp with time zone DEFAULT now(), p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  schedule public.organization_coordination_records%rowtype;
  run_count integer := 0;
  next_at timestamptz;
  chosen text;
  disabled boolean;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  if p_limit not between 1 and 200 then
    raise exception 'export batch limit unavailable' using errcode = '22023';
  end if;
  for schedule in
    select record.*
    from public.organization_coordination_records record
    where private.organization_is_union(record.organization_id)
      and record.kind = 'network_export_schedule' and record.status = 'active'
      and coalesce((record.config ->> 'nextRunAt')::timestamptz, p_now) <= p_now
    order by (record.config ->> 'nextRunAt')::timestamptz nulls first, record.id
    for update skip locked limit p_limit
  loop
    chosen := coalesce(schedule.config ->> 'dataset', 'coordination_records');
    disabled := private.organization_export_restored_dataset(chosen)
      and not private.organization_feature_enabled(schedule.organization_id, 'features.automation.scheduled_dataset_exports');
    insert into public.organization_coordination_export_runs (
      schedule_id, organization_id, requested_by, format, delivery_mode,
      status, row_count, idempotency_key, dataset, delivery_note
    ) values (
      schedule.id, schedule.organization_id, null,
      schedule.config ->> 'format', schedule.config ->> 'deliveryMode',
      case
        when disabled then 'skipped'
        when schedule.config ->> 'deliveryMode' = 'internal_download' then 'ready'
        else 'queued'
      end,
      case
        when disabled then 0
        when chosen = 'coordination_records' then (
          select pg_catalog.count(*)::integer
          from public.organization_coordination_records scoped
          where private.organization_is_union(scoped.organization_id)
      and (scoped.organization_id = schedule.organization_id
            or exists (
              select 1
              from public.organization_coordination_organization_participants participant
              where participant.record_id = scoped.id
                and participant.organization_id = schedule.organization_id
                and participant.status = 'active'
            )))
        else pg_catalog.jsonb_array_length(
          private.organization_export_dataset(schedule.organization_id, chosen) -> 'rows')
      end,
      extensions.gen_random_uuid(),
      chosen,
      case when disabled then 'dataset_disabled' end
    );
    next_at := case schedule.config ->> 'cadence'
      when 'daily' then p_now + interval '1 day'
      when 'weekly' then p_now + interval '7 days'
      when 'monthly' then p_now + interval '1 month'
    end;
    update public.organization_coordination_records
    set config = config || pg_catalog.jsonb_build_object(
      'lastRunAt', p_now, 'nextRunAt', next_at
    ), updated_at = pg_catalog.clock_timestamp()
    where id = schedule.id;
    run_count := run_count + 1;
  end loop;
  return pg_catalog.jsonb_build_object('processed', run_count, 'ranAt', p_now);
end;
end;
$function$;
revoke all on function public.run_due_organization_coordination_exports(timestamp with time zone, integer) from public, anon, authenticated, service_role;
grant execute on function public.run_due_organization_coordination_exports(timestamp with time zone, integer) to service_role;

-- Platform export boundary: public.claim_organization_export_deliveries(integer)
CREATE OR REPLACE FUNCTION public.claim_organization_export_deliveries(p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  claimed jsonb;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  with candidates as (
    select run.id
    from public.organization_coordination_export_runs run
    where private.organization_is_union(run.organization_id)
      and run.delivery_mode in ('email_unset', 'sftp_unset')
      and (
        run.status = 'queued'
        or (run.status = 'running' and run.delivery_claimed_at < pg_catalog.now() - interval '15 minutes')
      )
    order by run.created_at, run.id
    limit greatest(1, least(coalesce(p_limit, 25), 100))
    for update skip locked
  ), updated as (
    update public.organization_coordination_export_runs run
    set status = 'running', delivery_claimed_at = pg_catalog.now()
    from candidates
    where run.id = candidates.id
    returning run.*
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'runId', u.id,
    'organizationId', u.organization_id,
    'dataset', u.dataset,
    'format', u.format,
    'deliveryMode', u.delivery_mode,
    'expiresAt', u.expires_at,
    'organizationName', o.name,
    'recipient', (
      select pg_catalog.jsonb_build_object('email', au.email, 'lang', coalesce(p.language, 'en'))
      from public.organization_coordination_records schedule
      join auth.users au on au.id = schedule.created_by
      left join public.member_profiles p on p.id = au.id
      where schedule.id = u.schedule_id
        and au.email is not null
        and exists (
          select 1 from public.organization_memberships m
          where m.organization_id = u.organization_id and m.user_id = au.id and m.status = 'active'
        )
        and exists (
          select 1 from public.organization_role_grants g
          where g.organization_id = u.organization_id and g.user_id = au.id
            and g.role = any(private.organization_export_dataset_roles(u.dataset))
        )
    )
  ) order by u.created_at, u.id), '[]'::jsonb)
  into claimed
  from updated u
  join public.organizations o on o.id = u.organization_id;
  return claimed;
end;
end;
$function$;
revoke all on function public.claim_organization_export_deliveries(integer) from public, anon, authenticated, service_role;
grant execute on function public.claim_organization_export_deliveries(integer) to service_role;

-- Platform export boundary: public.complete_organization_export_delivery(uuid, text, text)
CREATE OR REPLACE FUNCTION public.complete_organization_export_delivery(p_run_id uuid, p_status text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  finished public.organization_coordination_export_runs%rowtype;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  if exists (select 1 from public.organization_coordination_export_runs r
    where r.id = p_run_id and not private.organization_is_union(r.organization_id)) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if p_status not in ('delivered', 'not_configured', 'failed')
     or (p_status = 'delivered' and p_note is not null)
     or (p_status <> 'delivered' and (p_note is null or p_note not in (
       'email_transport_unset', 'sftp_transport_unavailable', 'no_recipient', 'email_send_failed'
     ))) then
    raise exception 'invalid export delivery outcome' using errcode = '22023';
  end if;
  update public.organization_coordination_export_runs run
  set status = p_status,
      delivery_note = p_note,
      delivered_at = case when p_status = 'delivered' then pg_catalog.now() end
  where run.id = p_run_id
    and run.status = 'running'
    and run.delivery_mode in ('email_unset', 'sftp_unset')
  returning run.* into finished;
  if finished.id is null then
    raise exception 'claimed export delivery unavailable' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object('runId', finished.id, 'status', finished.status, 'note', finished.delivery_note);
end;
end;
$function$;
revoke all on function public.complete_organization_export_delivery(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.complete_organization_export_delivery(uuid, text, text) to service_role;

-- Snapshot projections retain personal participation and operational controls,
-- while withholding platform-owned aggregate results.
CREATE OR REPLACE FUNCTION private.engagement_member_snapshot_scoped()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
  actor_chapter text := private.current_member_chapter();
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'quarterlyGate', public.get_quarterly_survey_gate(),
    'surveys', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', survey.id,
        'title', survey.title,
        'description', survey.description,
        'cadence', survey.cadence,
        'periodKey', survey.period_key,
        'opensAt', survey.opens_at,
        'closesAt', survey.closes_at,
        'session', case when session.id is null then null else pg_catalog.jsonb_build_object(
          'id', session.id, 'status', session.status,
          'updatedAt', session.updated_at, 'submittedAt', session.submitted_at,
          'answers', coalesce((
            select pg_catalog.jsonb_object_agg(answer.question_id::text, answer.value)
            from public.organization_survey_answers answer
            where answer.session_id = session.id and answer.organization_id = org
          ), '{}'::jsonb)
        ) end,
        'questions', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', question.id, 'sortIndex', question.sort_index,
            'type', question.question_type, 'label', question.label,
            'required', question.required, 'options', question.options,
            'sectionKey', question.section_key, 'sectionTitle', question.section_title,
            'branchParentId', question.branch_parent_id, 'branchValue', question.branch_value,
            'scaleMinLabel', question.scale_min_label, 'scaleMaxLabel', question.scale_max_label,
            'maxSelections', question.max_selections
          ) order by question.sort_index)
          from public.organization_survey_questions question
          where question.survey_id = survey.id and question.organization_id = org
        ), '[]'::jsonb)
      ) order by survey.closes_at nulls last, survey.updated_at desc)
      from public.organization_surveys survey
      left join public.organization_survey_sessions session
        on session.survey_id = survey.id and session.respondent_user_id = actor
      where survey.organization_id = org
        and survey.status = 'open'
        and (survey.chapter_id is null or survey.chapter_id = actor_chapter)
        and (survey.opens_at is null or survey.opens_at <= pg_catalog.now())
        and (survey.closes_at is null or survey.closes_at > pg_catalog.now())
    ), '[]'::jsonb),
    'pulsePrompts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'eventId', event.id, 'promptId', prompt.id,
        'eventKey', prompt.event_key, 'question', prompt.question,
        'options', prompt.options, 'contextKey', event.context_key,
        'shownAt', event.shown_at
      ) order by event.shown_at desc)
      from public.organization_pulse_events event
      join public.organization_pulse_prompts prompt on prompt.id = event.prompt_id
      where event.organization_id = org and event.user_id = actor and event.state = 'shown'
    ), '[]'::jsonb),
    'livePolls', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', poll.id, 'title', poll.title, 'description', poll.description,
        'state', poll.state, 'eligibility', poll.eligibility,
        'resultsVisibility', poll.results_visibility,
        'scheduledAt', poll.scheduled_at, 'opensAt', poll.opens_at,
        'closesAt', poll.closes_at, 'closedAt', poll.closed_at,
        'quorumTarget', poll.quorum_target, 'voteCount', case when private.organization_is_union(poll.organization_id) then poll.vote_count else null end,
        'results', case
          when private.organization_is_union(poll.organization_id) and (poll.results_visibility = 'live'
            or (poll.results_visibility = 'after_close' and poll.state = 'closed'))
            then poll.result_cache else '[]'::jsonb end,
        'options', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', option.id, 'label', option.label, 'sortIndex', option.sort_index
          ) order by option.sort_index)
          from public.organization_live_poll_options option where option.poll_id = poll.id
        ), '[]'::jsonb),
        'attendance', case when attendance.user_id is null then null else pg_catalog.jsonb_build_object(
          'eligible', attendance.eligible, 'rsvp', attendance.rsvp,
          'checkedInAt', attendance.checked_in_at
        ) end,
        'canCheckIn', poll.eligibility = 'roster'
          and poll.state = 'open'
          and coalesce(attendance.eligible, false)
          and attendance.checked_in_at is null,
        'selectedOptionId', vote.option_id
      ) order by coalesce(poll.opens_at, poll.scheduled_at, poll.created_at) desc)
      from public.organization_live_polls poll
      left join public.organization_live_poll_attendance attendance
        on attendance.poll_id = poll.id and attendance.user_id = actor
      left join public.organization_live_poll_votes vote
        on vote.poll_id = poll.id and vote.voter_user_id = actor
      where poll.organization_id = org
        and poll.state in ('scheduled', 'open', 'closed')
        and (poll.chapter_id is null or poll.chapter_id = actor_chapter)
        and (poll.closed_at is null or poll.closed_at >= pg_catalog.now() - interval '90 days')
    ), '[]'::jsonb),
    'workspace', coalesce((
      select pg_catalog.jsonb_build_object(
        'moduleOrder', preference.module_order,
        'hiddenModules', preference.hidden_modules,
        'updatedAt', preference.updated_at
      )
      from public.compass_workspace_preferences preference
      where preference.organization_id = org and preference.user_id = actor
    ), pg_catalog.jsonb_build_object(
      'moduleOrder', '["inbox","surveys","tasks","cases"]'::jsonb,
      'hiddenModules', '[]'::jsonb
    )),
    'actions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', action.id, 'actionKind', action.action_kind,
        'sourceKind', action.source_kind, 'sourceId', action.source_id,
        'title', action.title, 'state', action.state,
        'resultTaskId', action.result_task_id, 'createdAt', action.created_at
      ) order by action.created_at desc)
      from public.compass_workspace_actions action
      where action.organization_id = org and action.actor_user_id = actor
        and action.state in ('proposed', 'failed')
    ), '[]'::jsonb),
    'briefings', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', briefing.id, 'sourceKind', briefing.source_kind,
        'targetId', briefing.target_id, 'summary', briefing.summary,
        'actionItems', briefing.action_items, 'createdAt', briefing.created_at
      ) order by briefing.created_at desc)
      from (
        select * from public.compass_message_briefings saved
        where saved.organization_id = org and saved.requested_by = actor
        order by saved.created_at desc limit 10
      ) briefing
    ), '[]'::jsonb)
  );
end;
$function$;
revoke all on function private.engagement_member_snapshot_scoped() from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.staff_engagement_survey_page(p_organization_id uuid, p_status text, p_after jsonb, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  page_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  after_rank integer;
  after_updated_at timestamptz;
  after_id uuid;
  page_ids uuid[];
  has_more boolean;
  next_cursor jsonb;
  surveys jsonb;
  counts jsonb;
begin
  if p_status is not null and p_status not in ('draft', 'open', 'closed') then
    raise exception 'unknown survey status' using errcode = '22023';
  end if;
  if p_after is not null then
    begin
      after_rank := (p_after ->> 'rank')::integer;
      after_updated_at := (p_after ->> 'updatedAt')::timestamptz;
      after_id := (p_after ->> 'id')::uuid;
    exception when others then
      raise exception 'invalid survey cursor' using errcode = '22023';
    end;
    if after_rank is null or after_updated_at is null or after_id is null then
      raise exception 'invalid survey cursor' using errcode = '22023';
    end if;
  end if;

  with ranked as (
    select survey.id, survey.updated_at,
      case survey.status when 'open' then 0 when 'draft' then 1 else 2 end as status_rank
    from public.organization_surveys survey
    where survey.organization_id = p_organization_id
      and (p_status is null or survey.status = p_status)
  ), window_rows as (
    select ranked.id, ranked.updated_at, ranked.status_rank,
      pg_catalog.row_number() over (order by ranked.status_rank, ranked.updated_at desc, ranked.id desc) as position
    from ranked
    where after_rank is null
       or ranked.status_rank > after_rank
       or (ranked.status_rank = after_rank and (ranked.updated_at, ranked.id) < (after_updated_at, after_id))
    order by ranked.status_rank, ranked.updated_at desc, ranked.id desc
    limit page_limit + 1
  )
  select
    coalesce(pg_catalog.array_agg(window_rows.id order by window_rows.position) filter (where window_rows.position <= page_limit), '{}'::uuid[]),
    pg_catalog.count(*) > page_limit,
    (pg_catalog.array_agg(pg_catalog.jsonb_build_object(
      'rank', window_rows.status_rank, 'updatedAt', window_rows.updated_at, 'id', window_rows.id
    )) filter (where window_rows.position = page_limit))[1]
  into page_ids, has_more, next_cursor
  from window_rows;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', survey.id, 'title', survey.title, 'status', survey.status,
    'cadence', survey.cadence, 'periodKey', survey.period_key,
    'privacyMinResponses', survey.privacy_min_responses,
    'operationsState', survey.operations_state, 'ownerUserId', survey.owner_user_id,
    'opensAt', survey.opens_at, 'closesAt', survey.closes_at,
    'reviewDueAt', survey.review_due_at,
    'coverage', case when private.organization_is_union(survey.organization_id) then pg_catalog.jsonb_build_object(
      'total', (select pg_catalog.count(*) from public.organization_survey_deliveries delivery where delivery.survey_id = survey.id),
      'sent', (select pg_catalog.count(*) from public.organization_survey_deliveries delivery where delivery.survey_id = survey.id and delivery.state in ('sent', 'engaged')),
      'engaged', (select pg_catalog.count(*) from public.organization_survey_deliveries delivery where delivery.survey_id = survey.id and delivery.state = 'engaged'),
      'failed', (select pg_catalog.count(*) from public.organization_survey_deliveries delivery where delivery.survey_id = survey.id and delivery.state = 'failed')
    ) else null end,
    'tasks', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', task.id, 'reason', task.reason, 'status', task.status,
        'assignedTo', task.assigned_to, 'dueAt', task.due_at
      ) order by task.created_at)
      from public.organization_survey_tasks task where task.survey_id = survey.id
    ), '[]'::jsonb),
    'reviewLane', lane.value,
    'reviewCounts', case when lane.value ->> 'state' = 'ready' then coalesce((
      select pg_catalog.jsonb_object_agg(counts.state, counts.count)
      from (
        select review.state, pg_catalog.count(*)::integer as count
        from public.organization_survey_reviews review
        where review.survey_id = survey.id group by review.state
      ) counts
    ), '{}'::jsonb) else '{}'::jsonb end,
    'reviews', case when lane.value ->> 'state' = 'ready' then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', review.id, 'sessionId', review.session_id,
        'state', review.state, 'assignedTo', review.assigned_to,
        'disposition', review.disposition,
        'followUpDueAt', review.follow_up_due_at,
        'createdAt', review.created_at
      ) order by review.created_at desc)
      from public.organization_survey_reviews review
      where review.survey_id = survey.id
    ), '[]'::jsonb) else '[]'::jsonb end,
    'questions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', question.id, 'sortIndex', question.sort_index,
        'type', question.question_type, 'label', question.label,
        'required', question.required, 'options', question.options,
        'sectionKey', question.section_key, 'sectionTitle', question.section_title,
        'branchParentId', question.branch_parent_id,
        'branchValue', question.branch_value
      ) order by question.sort_index)
      from public.organization_survey_questions question
      where question.survey_id = survey.id
    ), '[]'::jsonb)
  ) order by page.position), '[]'::jsonb)
  into surveys
  from pg_catalog.unnest(page_ids) with ordinality as page(id, position)
  join public.organization_surveys survey
    on survey.id = page.id and survey.organization_id = p_organization_id
  cross join lateral (
    select case when private.organization_is_union(survey.organization_id) then private.organization_survey_review_lane(p_organization_id, survey.id)
      else pg_catalog.jsonb_build_object('state','withheld','responseCount',null,'privacyMinResponses',survey.privacy_min_responses) end as value
  ) lane;

  select pg_catalog.jsonb_build_object(
    'all', pg_catalog.count(*),
    'open', pg_catalog.count(*) filter (where survey.status = 'open'),
    'draft', pg_catalog.count(*) filter (where survey.status = 'draft'),
    'closed', pg_catalog.count(*) filter (where survey.status = 'closed')
  )
  into counts
  from public.organization_surveys survey
  where survey.organization_id = p_organization_id;

  return pg_catalog.jsonb_build_object(
    'surveys', surveys,
    'nextCursor', case when has_more then next_cursor else null end,
    'counts', counts,
    'status', p_status,
    'limit', page_limit
  );
end;
$function$;
revoke all on function private.staff_engagement_survey_page(uuid, text, jsonb, integer) from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_collective_actions(p_selected_hat text, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.mi1_require_selected_organization();
  caller uuid := (select auth.uid());
  manager boolean;
  organization_editor boolean;
  total_count integer;
  action_rows jsonb;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  manager := p_selected_hat in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
    and private.has_organization_role(org, array[p_selected_hat]);
  -- Mirrors public.save_digital_action's object-level rule: an organization
  -- officer hat may edit any action; any other manager hat only its own.
  organization_editor := manager and p_selected_hat in ('advisor', 'admin', 'vp');
  if coalesce(p_limit, 0) not between 1 and 100
     or coalesce(p_offset, -1) not between 0 and 10000 then
    raise exception 'invalid pagination' using errcode = '22023';
  end if;
  select pg_catalog.count(*)::integer into total_count
  from public.digital_actions a
  where a.organization_id = org and (a.status <> 'draft' or manager);

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', a.id, 'chapterId', a.chapter_id, 'kind', a.action_kind,
    'title', a.title, 'summary', a.summary, 'status', a.status,
    'targetCount', a.target_count, 'startsAt', a.starts_at,
    'endsAt', a.ends_at, 'publishedAt', a.published_at,
    'participantCount', case when private.organization_is_union(a.organization_id) then counted.value else null end,
    'viewerParticipation', mine.participation_kind,
    'viewerCanEdit', manager and (organization_editor or a.created_by = caller)
  ) order by
    case a.status when 'published' then 0 when 'draft' then 1 when 'closed' then 2 else 3 end,
    a.starts_at desc nulls last, a.created_at desc, a.id), '[]'::jsonb)
  into action_rows
  from (
    select page.* from public.digital_actions page
    where page.organization_id = org and (page.status <> 'draft' or manager)
    order by
      case page.status when 'published' then 0 when 'draft' then 1 when 'closed' then 2 else 3 end,
      page.starts_at desc nulls last, page.created_at desc, page.id
    limit p_limit offset p_offset
  ) a
  cross join lateral (
    select pg_catalog.count(*)::integer as value
    from public.digital_action_participants p
    where p.organization_id = org and p.action_id = a.id
      and private.organization_is_union(a.organization_id)
  ) counted
  left join lateral (
    select p.participation_kind
    from public.digital_action_participants p
    where p.organization_id = org and p.action_id = a.id and p.user_id = caller
    limit 1
  ) mine on true;

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'generatedAt', pg_catalog.now(),
    'actions', action_rows,
    'pageSize', p_limit,
    'offset', p_offset,
    'totalCount', total_count,
    'nextOffset', case
      when p_offset + pg_catalog.jsonb_array_length(action_rows) < total_count
      then p_offset + pg_catalog.jsonb_array_length(action_rows)
      else null
    end
  );
end;
$function$;
revoke all on function public.get_collective_actions(text, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.get_collective_actions(text, integer, integer) to authenticated;

CREATE OR REPLACE FUNCTION public.get_staff_engagement_snapshot()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.engagement_selected_organization();
  survey_page jsonb;
begin
  perform private.engagement_require_staff(org);
  survey_page := private.staff_engagement_survey_page(org, null, null, 20);
  return pg_catalog.jsonb_build_object(
    'surveys', survey_page -> 'surveys',
    'surveyCounts', survey_page -> 'counts',
    'surveyCursor', survey_page -> 'nextCursor',
    'pulsePrompts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', prompt.id, 'chapterId', prompt.chapter_id,
        'eventKey', prompt.event_key, 'question', prompt.question,
        'options', prompt.options, 'active', prompt.active,
        'cooldownHours', prompt.cooldown_hours,
        'shown', case when private.organization_is_union(prompt.organization_id) then (select pg_catalog.count(*) from public.organization_pulse_events event where event.prompt_id = prompt.id) else null end,
        'responded', case when private.organization_is_union(prompt.organization_id) then (select pg_catalog.count(*) from public.organization_pulse_events event where event.prompt_id = prompt.id and event.state = 'responded') else null end
      ) order by prompt.updated_at desc)
      from public.organization_pulse_prompts prompt where prompt.organization_id = org
    ), '[]'::jsonb),
    'livePolls', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', poll.id, 'title', poll.title, 'description', poll.description,
        'state', poll.state, 'eligibility', poll.eligibility,
        'resultsVisibility', poll.results_visibility,
        'scheduledAt', poll.scheduled_at, 'opensAt', poll.opens_at,
        'closesAt', poll.closes_at, 'closedAt', poll.closed_at,
        'quorumTarget', poll.quorum_target, 'voteCount', case when private.organization_is_union(poll.organization_id) then poll.vote_count else null end,
        'results', case when private.organization_is_union(poll.organization_id) then poll.result_cache else '[]'::jsonb end,
        'options', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', option.id, 'label', option.label, 'sortIndex', option.sort_index
          ) order by option.sort_index)
          from public.organization_live_poll_options option where option.poll_id = poll.id
        ), '[]'::jsonb),
        'attendance', case when private.organization_is_union(poll.organization_id) then pg_catalog.jsonb_build_object(
          'roster', (select pg_catalog.count(*) from public.organization_live_poll_attendance attendance where attendance.poll_id = poll.id and attendance.eligible),
          'rsvpYes', (select pg_catalog.count(*) from public.organization_live_poll_attendance attendance where attendance.poll_id = poll.id and attendance.rsvp = 'yes'),
          'checkedIn', (select pg_catalog.count(*) from public.organization_live_poll_attendance attendance where attendance.poll_id = poll.id and attendance.checked_in_at is not null)
        ) else null end
      ) order by coalesce(poll.opens_at, poll.scheduled_at, poll.created_at) desc)
      from public.organization_live_polls poll where poll.organization_id = org
    ), '[]'::jsonb),
    'delivery', coalesce((
      select pg_catalog.jsonb_object_agg(summary.state, summary.count)
      from (
        select outbox.state, pg_catalog.count(*)::integer as count
        from public.engagement_delivery_outbox outbox
        where outbox.organization_id = org group by outbox.state
      ) summary
    ), '{}'::jsonb),
    'presence', pg_catalog.jsonb_build_object(
      'online', (select pg_catalog.count(*) from public.member_presence presence where presence.organization_id = org and presence.status = 'online' and presence.last_seen_at >= pg_catalog.now() - interval '2 minutes'),
      'away', (select pg_catalog.count(*) from public.member_presence presence where presence.organization_id = org and presence.last_seen_at >= pg_catalog.now() - interval '15 minutes')
    ),
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', chapter.id, 'name', chapter.name
      ) order by chapter.order_index, chapter.name, chapter.id)
      from public.chapters chapter
      where chapter.organization_id = org
    ), '[]'::jsonb),
    'members', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', membership.user_id,
        'name', coalesce(profile.full_name, 'Member'),
        'chapterId', profile.chapter_id
      ) order by coalesce(profile.full_name, ''), membership.user_id)
      from public.organization_memberships membership
      left join public.member_profiles profile on profile.id = membership.user_id
      where membership.organization_id = org
        and membership.status = 'active' and membership.revoked_at is null
    ), '[]'::jsonb),
    'channels', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'spaceId', space.id, 'name', space.name,
        'chapterId', chapter.id, 'chapterName', chapter.name,
        'postingMode', coalesce(control.posting_mode, 'members'),
        'slowModeSeconds', coalesce(control.slow_mode_seconds, 0),
        'approvalsRequired', coalesce(control.approvals_required, false)
      ) order by chapter.order_index, chapter.name, chapter.id, space.name, space.id)
      from public.chapter_spaces space
      join public.chapters chapter on chapter.id = space.chapter_id and chapter.organization_id = org
      left join public.chapter_space_controls control on control.space_id = space.id
      where space.archived_at is null
    ), '[]'::jsonb)
  );
end;
$function$;
revoke all on function public.get_staff_engagement_snapshot() from public, anon, authenticated, service_role;
grant execute on function public.get_staff_engagement_snapshot() to authenticated;

-- Organization-scoped report reads use the same platform boundary.

create or replace function public.get_coordinator_kpis()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  open_cases integer;
  due_week integer;
  in_arb integer;
  resolved_cases integer;
  by_step jsonb;
  by_article jsonb;
begin
  if caller is null or not public.member_has_role(array['coordinator']) then
    raise exception 'coordinator role required' using errcode = '42501';
  end if;
  if private.organization_is_platform(private.current_member_organization()) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  -- Bound 1, TENANT: the caller's own organization and chapter, or a case the
  -- caller holds an active grant for while staff_can_see_user admits them
  -- (20261022053100), copied from
  -- private.casework_dashboard_open_cases (20260917142000) minus its
  -- status = 'active' filter, because `resolved` and resolutionRate need the
  -- resolved half of the same scope.
  -- Bound 2, VISIBILITY: the casework suite's own per-case helper, run over the
  -- tenant-bounded set only.
  -- The CTEs are materialized so both run once per call and the count filters
  -- plus the two grouped tallies read the same set, instead of three
  -- independent scans. Due window is current_date + 6: seven days inclusive of
  -- today (public.list_coordinator_cases mirrors it exactly).
  with tenant as materialized (
    select c.id, c.status, c.step, c.articles, c.deadline
    from public.member_cases c
    where private.organization_is_union(c.organization_id)
      and c.chapter_id is not null
      and (
        (c.organization_id = (select private.current_member_organization())
          and c.chapter_id = (select private.current_member_chapter()))
        or (
          c.id in (
            select g.case_id
            from public.casework_access_grants g
            where g.grantee_user_id = (select auth.uid())
              and g.revoked_at is null
          )
          and public.staff_can_see_user(c.user_id, 'coordinator')
          and private.casework_staff_can_access(c.id)
        )
      )
  ),
  base as materialized (
    select t.status, t.step, t.articles, t.deadline
    from tenant t
    where private.casework_staff_can_access(t.id)
  )
  select
    pg_catalog.count(*) filter (where b.status = 'active'),
    pg_catalog.count(*) filter (where b.status = 'active'
      and b.deadline is not null
      and b.deadline between current_date and current_date + 6),
    pg_catalog.count(*) filter (where b.status = 'active'
      and (b.step ~* 'arb' or b.step = 'Step 4')),
    pg_catalog.count(*) filter (where b.status = 'resolved'),
    (select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('step', s.step, 'count', s.n) order by s.n desc, s.step), '[]'::jsonb)
     from (
       select step, pg_catalog.count(*) as n
       from base
       where status = 'active'
       group by step
     ) s),
    (select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('articles', a.articles, 'count', a.n) order by a.n desc, a.articles), '[]'::jsonb)
     from (
       select articles, pg_catalog.count(*) as n
       from base
       where status = 'active' and articles <> ''
       group by articles
     ) a)
  into open_cases, due_week, in_arb, resolved_cases, by_step, by_article
  from base b;

  return pg_catalog.jsonb_build_object(
    'openCases', open_cases,
    'dueThisWeek', due_week,
    'inArbitration', in_arb,
    'resolved', resolved_cases,
    'resolutionRate', case when open_cases + resolved_cases = 0 then null
      else pg_catalog.round(100.0 * resolved_cases / (open_cases + resolved_cases)) end,
    'byStep', by_step,
    'byArticle', by_article);
end;
$$;
revoke all on function public.get_coordinator_kpis() from public, anon, authenticated, service_role;
grant execute on function public.get_coordinator_kpis() to authenticated;


create or replace function public.get_organization_coordination_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  staff boolean;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if organization is null then
    return pg_catalog.jsonb_build_object(
      'state', 'empty', 'organizationId', null, 'staff', false,
      'records', '[]'::jsonb,
      'messages', '[]'::jsonb, 'resources', '[]'::jsonb,
      'exportRuns', '[]'::jsonb, 'outreach', '[]'::jsonb
    );
  end if;
  if not private.is_organization_member(organization) then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  if not private.organization_is_union(organization) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  staff := private.organization_coordination_is_staff(organization);
  return (
    with visible_records as materialized (
      select * from private.organization_coordination_visible_records(organization, caller, staff)
    )
    select pg_catalog.jsonb_build_object(
    'state', 'ready',
    'organizationId', organization,
    'staff', staff,
    'records', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'kind', r.kind, 'title', r.title, 'summary', r.summary,
        'status', r.status, 'visibility', r.visibility,
        'organizationId', r.organization_id,
        'partnerOrganizationId', r.partner_organization_id,
        'chapterId', r.chapter_id, 'parentId', r.parent_id,
        'config', case when staff or r.visibility <> 'staff' then r.config else '{}'::jsonb end,
        'completedByCaller', exists (
          select 1
          from public.organization_coordination_events event
          where event.record_id = r.id
            and event.actor_user_id = caller
            and event.event_type = 'complete_objective'
        ),
        'createdAt', r.created_at, 'updatedAt', r.updated_at
      ) order by r.updated_at desc, r.id desc)
      from (
        select visible.*
        from visible_records visible
        order by visible.updated_at desc, visible.id desc
        limit 50
      ) r
    ), '[]'::jsonb),
    'messages', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', m.id, 'conversationId', m.conversation_id,
        'senderOrganizationId', m.sender_organization_id,
        'body', m.body, 'createdAt', m.created_at
      ) order by m.created_at desc, m.id desc)
      from (
        select message.*
        from public.organization_coordination_messages message
        join visible_records visible on visible.id = message.conversation_id
        order by message.created_at desc, message.id desc
        limit 30
      ) m
    ), '[]'::jsonb),
    'resources', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', x.id, 'recordId', x.record_id, 'kind', x.resource_kind,
        'title', x.title, 'status', x.status,
        'fromOrganizationId', x.from_organization_id,
        'toOrganizationId', x.to_organization_id,
        'documentId', x.chapter_document_id, 'updatedAt', x.updated_at
      ) order by x.updated_at desc, x.id desc)
      from public.organization_coordination_resources x
      join visible_records visible on visible.id = x.record_id
    ), '[]'::jsonb),
    'exportRuns', case when staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', e.id, 'scheduleId', e.schedule_id, 'format', e.format,
        'deliveryMode', e.delivery_mode, 'status', e.status,
        'rowCount', e.row_count, 'expiresAt', e.expires_at,
        'createdAt', e.created_at
      ) order by e.created_at desc, e.id desc)
      from public.organization_coordination_export_runs e
      where e.organization_id = organization
    ), '[]'::jsonb) else '[]'::jsonb end,
    'outreach', case when staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', o.id, 'campaignId', o.campaign_id,
        'targetUserId', o.target_user_id, 'disposition', o.disposition,
        'note', o.note, 'contactedAt', o.contacted_at
      ) order by o.contacted_at desc, o.id desc)
      from public.organization_coordination_outreach_events o
      where o.organization_id = organization
    ), '[]'::jsonb) else '[]'::jsonb end
  ));
end;
$function$;
revoke all on function public.get_organization_coordination_snapshot() from public, anon, authenticated, service_role;
grant execute on function public.get_organization_coordination_snapshot() to authenticated;


create or replace function public.list_organization_coordination_records(
  p_before_updated_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  page_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  staff boolean;
  payload jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
     or not private.is_organization_member(organization) then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  if not private.organization_is_union(organization) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if (p_before_updated_at is null) <> (p_before_id is null) then
    raise exception 'complete coordination cursor required' using errcode = '22023';
  end if;
  staff := private.organization_coordination_is_staff(organization);

  with candidates as materialized (
    select record.*
    from public.organization_coordination_records record
    where private.organization_coordination_can_read(record.id)
      and (
        p_before_updated_at is null
        or (record.updated_at, record.id) < (p_before_updated_at, p_before_id)
      )
    order by record.updated_at desc, record.id desc
    limit page_limit + 1
  ), page as (
    select * from candidates
    order by updated_at desc, id desc
    limit page_limit
  )
  select pg_catalog.jsonb_build_object(
    'records', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', record.id, 'kind', record.kind,
        'title', record.title, 'summary', record.summary,
        'status', record.status, 'visibility', record.visibility,
        'organizationId', record.organization_id,
        'partnerOrganizationId', record.partner_organization_id,
        'chapterId', record.chapter_id, 'parentId', record.parent_id,
        'config', case when staff or record.visibility <> 'staff'
          then record.config else '{}'::jsonb end,
        'completedByCaller', exists (
          select 1
          from public.organization_coordination_events event
          where event.record_id = record.id
            and event.actor_user_id = caller
            and event.event_type = 'complete_objective'
        ),
        'createdAt', record.created_at, 'updatedAt', record.updated_at
      ) order by record.updated_at desc, record.id desc)
      from page record
    ), '[]'::jsonb),
    'nextCursor', case when (select pg_catalog.count(*) from candidates) > page_limit
      then (select pg_catalog.jsonb_build_object(
        'updatedAt', record.updated_at, 'id', record.id
      ) from page record order by record.updated_at, record.id limit 1)
      else null end
  ) into payload;

  return payload;
end;
$function$;
revoke all on function public.list_organization_coordination_records(timestamptz, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.list_organization_coordination_records(timestamptz, uuid, integer) to authenticated;


create or replace function public.list_organization_coordination_messages(
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  page_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  payload jsonb;
  staff boolean;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.is_organization_member(organization) then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  if not private.organization_is_union(organization) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if (p_before_created_at is null) <> (p_before_id is null) then
    raise exception 'complete message cursor required' using errcode = '22023';
  end if;
  staff := private.organization_coordination_is_staff(organization);
  with visible_records as materialized (
    select * from private.organization_coordination_visible_records(organization, caller, staff)
  ), candidates as materialized (
    select message.*
    from public.organization_coordination_messages message
    join visible_records visible on visible.id = message.conversation_id
    where (
        p_before_created_at is null
        or (message.created_at, message.id) < (p_before_created_at, p_before_id)
      )
    order by message.created_at desc, message.id desc
    limit page_limit + 1
  ), page as (
    select * from candidates
    order by created_at desc, id desc
    limit page_limit
  )
  select pg_catalog.jsonb_build_object(
    'messages', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', message.id,
        'conversationId', message.conversation_id,
        'senderOrganizationId', message.sender_organization_id,
        'body', message.body,
        'createdAt', message.created_at
      ) order by message.created_at desc, message.id desc)
      from page message
    ), '[]'::jsonb),
    'nextCursor', case when (select pg_catalog.count(*) from candidates) > page_limit
      then (select pg_catalog.jsonb_build_object(
        'createdAt', message.created_at, 'id', message.id
      ) from page message order by message.created_at, message.id limit 1)
      else null end
  ) into payload;
  return payload;
end;
$function$;
revoke all on function public.list_organization_coordination_messages(timestamptz, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.list_organization_coordination_messages(timestamptz, uuid, integer) to authenticated;


-- Direct poll reads, participation totals, workload statistics, chapter health
-- and weekly issue digests use the same platform boundary. Platform polls are
-- withheld from direct table and realtime reads (the vote RPCs and the
-- engagement snapshot keep personal participation); the participation RPC
-- withholds platform totals like get_collective_actions; workload statistics
-- refuse a platform chapter before aggregation; the chapter-health helper that
-- the portfolio, recorder and snapshot policies share refuses platform
-- chapters; the digest generator skips platform organizations and the shared
-- digest helper refuses them. Re-emitted from the installed definitions.
create policy platform_live_poll_boundary on public.organization_live_polls
as restrictive for select to authenticated
using (private.organization_is_union(organization_id));
comment on policy platform_live_poll_boundary on public.organization_live_polls is
  'REQ-UG-PLATFORM-ORG-PRODUCTION-20261012: the platform organization is never a union surface, so its polls, vote counts and cached results are withheld from direct and realtime member reads; the vote RPCs and the engagement snapshot keep personal participation.';

-- Platform participation boundary: public.toggle_digital_action_participation(uuid, text, boolean)
create or replace function public.toggle_digital_action_participation(
  p_action_id uuid,
  p_participation_kind text,
  p_joined boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.mi1_require_selected_organization();
  caller uuid := (select auth.uid());
  action_row public.digital_actions%rowtype;
  participant_count integer;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_action_id is null or p_participation_kind not in ('signature', 'attendee', 'volunteer') or p_joined is null then
    raise exception 'invalid participation request' using errcode = '22023';
  end if;
  select a.* into action_row from public.digital_actions a
  where a.id = p_action_id and a.organization_id = org for update;
  if not found then raise exception 'digital action not found' using errcode = 'P0002'; end if;
  if action_row.status <> 'published'
     or (action_row.starts_at is not null and action_row.starts_at > pg_catalog.now())
     or (action_row.ends_at is not null and action_row.ends_at < pg_catalog.now()) then
    raise exception 'digital action is not accepting participation' using errcode = '55000';
  end if;
  if p_joined then
    insert into public.digital_action_participants (
      organization_id, action_id, user_id, participation_kind
    ) values (org, p_action_id, caller, p_participation_kind)
    on conflict (action_id, user_id) do update set
      participation_kind = excluded.participation_kind,
      updated_at = pg_catalog.now();
  else
    delete from public.digital_action_participants p
    where p.organization_id = org and p.action_id = p_action_id and p.user_id = caller;
  end if;
  perform private.write_organization_intelligence_audit(
    org,
    case when p_joined then 'digital_action_participation_joined' else 'digital_action_participation_withdrawn' end,
    'digital_action_participation', p_action_id::text || ':' || caller::text,
    pg_catalog.jsonb_build_object('participationKind', p_participation_kind)
  );
  select pg_catalog.count(*)::integer into participant_count
  from public.digital_action_participants p
  where p.organization_id = org and p.action_id = p_action_id;
  return pg_catalog.jsonb_build_object(
    'actionId', p_action_id, 'organizationId', org, 'joined', p_joined,
    'participationKind', case when p_joined then p_participation_kind else null end,
    'participantCount', case when private.organization_is_union(org) then participant_count else null end
  );
end;
end;
$function$;
revoke all on function public.toggle_digital_action_participation(uuid, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.toggle_digital_action_participation(uuid, text, boolean) to authenticated;


-- Platform report boundary: public.get_workload_stats()
create or replace function public.get_workload_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  loc_now timestamp := (pg_catalog.now() at time zone 'America/New_York');
  q_start_local timestamp := pg_catalog.date_trunc('quarter', loc_now) - interval '3 months';
  q_end_local timestamp := pg_catalog.date_trunc('quarter', loc_now);
  q_start timestamptz := q_start_local at time zone 'America/New_York';
  q_end timestamptz := q_end_local at time zone 'America/New_York';
  period_label text := pg_catalog.date_part('year', q_start_local)::int::text
    || '-Q' || pg_catalog.date_part('quarter', q_start_local)::int::text;
  n_sub integer;
  k constant integer := 25;
  cats jsonb;
  tiles jsonb;
  band text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  -- Quarterly "give to view": a locked member gets no workload statistics.
  if private.quarterly_survey_gate_locks_caller() then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'reason', 'quarterly_survey_gate', 'locked', true,
      'minSubmitters', k, 'period', period_label, 'generatedAt', pg_catalog.now());
  end if;
  if caller_chapter is null then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'reason', 'chapter_unavailable',
      'minSubmitters', k, 'period', period_label, 'generatedAt', pg_catalog.now());
  end if;
  if private.chapter_belongs_to_platform(caller_chapter) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  select pg_catalog.count(*) into n_sub from (
    select distinct on (w.user_id) w.id
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and w.created_at >= q_start and w.created_at < q_end
    order by w.user_id, w.created_at desc
  ) s;

  if n_sub < k then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'reason', 'anonymity_floor',
      'minSubmitters', k, 'period', period_label, 'generatedAt', pg_catalog.now());
  end if;
  band := case when n_sub >= 100 then '100+' when n_sub >= 50 then '50-99' else '25-49' end;

  with latest as (
    select distinct on (w.user_id)
      w.priority, w.pending, w.unread_docs, w.todos, w.referrals,
      w.ce_activities, w.assistance_requests, w.aged_cases,
      w.employment, least(w.ot_hours, 40) as ot_hours
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and w.created_at >= q_start and w.created_at < q_end
    order by w.user_id, w.created_at desc
  ), values_by_key as (
    select v.key, v.ord, least(v.value, 150)::numeric as value
    from latest l
    cross join lateral (values
      ('priority', 1, l.priority), ('pending', 2, l.pending),
      ('unread_docs', 3, l.unread_docs), ('todos', 4, l.todos),
      ('referrals', 5, l.referrals), ('ce_activities', 6, l.ce_activities),
      ('assistance_requests', 7, l.assistance_requests), ('aged_cases', 8, l.aged_cases)
    ) v(key, ord, value)
  ), metrics as (
    select key, ord,
      pg_catalog.round(pg_catalog.avg(value)) as avg,
      pg_catalog.percentile_disc(0.5) within group (order by value) as median,
      pg_catalog.percentile_disc(0.9) within group (order by value) as p90
    from values_by_key group by key, ord
  )
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'key', key, 'avg', avg, 'median', median, 'p90', p90) order by ord)
  into cats from metrics;

  with latest as (
    select distinct on (w.user_id) w.employment, least(w.ot_hours, 40) as ot_hours
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and w.created_at >= q_start and w.created_at < q_end
    order by w.user_id, w.created_at desc
  )
  select pg_catalog.jsonb_build_object(
    'pctFullTime', pg_catalog.round(100.0 * pg_catalog.avg((employment = 'full_time')::int) / 10.0) * 10,
    'pctPartTime', pg_catalog.round(100.0 * pg_catalog.avg((employment = 'part_time')::int) / 10.0) * 10,
    'avgOtHours', pg_catalog.round(pg_catalog.avg(ot_hours)::numeric, 1))
  into tiles from latest;

  return pg_catalog.jsonb_build_object(
    'enoughData', true, 'period', period_label, 'generatedAt', pg_catalog.now(),
    'submittersBand', band, 'categories', cats, 'tiles', tiles);
end;
$function$;


-- Platform analytics boundary: private.can_manage_chapter_health(text)
create or replace function private.can_manage_chapter_health(p_chapter_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.chapters chapter
    where chapter.id = p_chapter_id
      and not private.chapter_belongs_to_platform(chapter.id)
      and (
        private.member_has_chapter_role(chapter.id, array['advisor','admin','vp'])
        or (
          chapter.organization_id is not null
          and chapter.organization_id = private.current_mobile_staff_organization()
          and private.mfa_satisfied()
          and (
            not private.staff_mfa_required(chapter.organization_id)
            or private.has_second_factor((select auth.uid()))
          )
          and exists (
            select 1
            from public.organization_role_grants role_grant
            join public.organization_memberships membership
              on membership.organization_id = role_grant.organization_id
             and membership.user_id = role_grant.user_id
             and membership.status = 'active'
            where role_grant.organization_id = chapter.organization_id
              and role_grant.user_id = (select auth.uid())
              and role_grant.role in ('advisor','admin','vp')
          )
        )
      )
  );
$function$;
revoke all on function private.can_manage_chapter_health(text) from public, anon, authenticated, service_role;
grant execute on function private.can_manage_chapter_health(text) to authenticated;

-- Platform analytics boundary: private.generate_issue_intelligence_weekly_digests(timestamptz, integer, boolean)
create or replace function private.generate_issue_intelligence_weekly_digests(
  p_now timestamptz default pg_catalog.now(),
  p_limit integer default 200,
  p_force boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  local_now timestamp := coalesce(p_now, pg_catalog.now()) at time zone 'America/New_York';
  week record;
  org record;
  family text;
  signal jsonb;
  floor_size integer;
  inserted integer := 0;
  added integer;
begin
  if not coalesce(p_force, false)
     and (pg_catalog.date_part('isodow', local_now) <> 1 or pg_catalog.date_part('hour', local_now) < 9) then
    return 0;
  end if;
  select * into week from private.issue_digest_completed_week(p_now);
  delete from private.issue_intelligence_weekly_digests d
  where not exists (select 1 from public.organizations o where o.id = d.organization_id);
  delete from private.issue_intelligence_digest_visits v
  where v.window_start < week.window_start - 56
     or not exists (select 1 from public.organizations o where o.id = v.organization_id);

  for org in
    select o.id
    from public.organizations o
    where o.status = 'active' and o.kind = 'union'
      and private.organization_feature_enabled(o.id, 'features.intelligence.issue_signals')
      and private.organization_feature_enabled(o.id, 'features.intelligence.weekly_digest')
      and not exists (
        select 1 from private.issue_intelligence_digest_visits v
        where v.organization_id = o.id and v.window_start = week.window_start
      )
    order by o.id
    limit greatest(1, least(coalesce(p_limit, 200), 1000))
  loop
    insert into private.issue_intelligence_digest_visits (organization_id, window_start)
    values (org.id, week.window_start)
    on conflict on constraint issue_intelligence_digest_visits_pkey do nothing;
    floor_size := greatest(15, coalesce(private.organization_limit(org.id, 'limits.intelligence.issue_signal_min_segment'), 15));
    foreach family in array array['retaliation_protected_activity_pressure', 'contract_rights_confusion'] loop
      if family = 'retaliation_protected_activity_pressure'
         and not private.organization_feature_enabled(org.id, 'features.intelligence.issue_signals_retaliation_family') then
        continue;
      end if;
      if family = 'contract_rights_confusion'
         and not private.organization_feature_enabled(org.id, 'features.intelligence.issue_signals_contract_rights_family') then
        continue;
      end if;
      -- The old digest used the completed week as its window (weekly-digest-store.ts:259-276).
      signal := private.issue_intelligence_family_signal(org.id, family, week.ends_at, 7);
      if not (signal ->> 'active')::boolean or (signal ->> 'contributors')::integer < floor_size then
        continue;
      end if;
      insert into private.issue_intelligence_weekly_digests (
        organization_id, window_start, window_end, thread_family, confidence_label, trend, evidence, recommendations, ai_status
      ) values (
        org.id, week.window_start, week.window_end, family,
        case signal ->> 'confidence' when 'strong' then 'high' when 'active' then 'medium' else 'low' end,
        signal ->> 'trend',
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'evidenceFamilies', signal -> 'evidenceFamilies',
          'qa', private.issue_digest_band((signal #>> '{evidence,qa}')::integer),
          'messages', private.issue_digest_band((signal #>> '{evidence,messages}')::integer),
          'cases', private.issue_digest_band((signal #>> '{evidence,cases}')::integer),
          'polls', private.issue_digest_band((signal #>> '{evidence,polls}')::integer),
          'retaliationReports', private.issue_digest_band((signal #>> '{evidence,retaliationReports}')::integer),
          'kyr', private.issue_digest_band((signal #>> '{evidence,kyr}')::integer),
          'reviewedThemes', case when (signal #>> '{evidence,reviewedThemes}')::boolean then true end
        )),
        private.issue_digest_recommendations(signal, private.organization_limit(org.id, 'limits.intelligence.digest_max_recommendations')),
        case when private.organization_feature_enabled(org.id, 'features.intelligence.weekly_digest_ai')
          then 'available' else 'not_requested' end
      )
      on conflict on constraint issue_intelligence_weekly_digests_one_per_week do nothing;
      get diagnostics added = row_count;
      inserted := inserted + added;
    end loop;
  end loop;
  return inserted;
end;
$function$;
revoke all on function private.generate_issue_intelligence_weekly_digests(timestamptz, integer, boolean) from public, anon, authenticated, service_role;

-- Platform analytics boundary: private.issue_digest_staff_organization(text)
create or replace function private.issue_digest_staff_organization(p_selected_hat text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  hat text := coalesce(nullif(pg_catalog.btrim(coalesce(p_selected_hat, '')), ''), '');
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  org := private.mi1_require_selected_organization();
  if hat not in ('steward', 'coordinator', 'admin') then
    raise exception 'staff hat required' using errcode = '42501';
  end if;
  if not (
    private.has_organization_role(org, array[hat])
    or exists (
      select 1 from public.chapters c
      where c.organization_id = org and private.member_has_chapter_role(c.id, array[hat])
    )
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  return org;
end;
$function$;
revoke all on function private.issue_digest_staff_organization(text) from public, anon, authenticated, service_role;

-- New trigger/function definitions enter the existing lifecycle review ledger;
-- the ledger remains an inventory, never a waiver of account deletion checks.
-- Round 7 analytics entry-point boundaries. Re-emitted from the merged
-- disposable installation, preserving authorization, volatility and grants.

-- civic_campaign_stats_for_org
CREATE OR REPLACE FUNCTION public.civic_campaign_stats_for_org(p_org text)
 RETURNS TABLE(campaign_id uuid, messages_sent bigint, messages_drafted bigint, members_participating bigint, officials_contacted bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not (select private.mfa_satisfied()) or not public.civic_is_org_officer(p_org) then
    raise exception 'officers only' using errcode = '42501';
  end if;
  if not private.chapter_belongs_to_union(p_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  return query
    select stats.campaign_id, stats.messages_sent, stats.messages_drafted,
           stats.members_participating, stats.officials_contacted
    from public.civic_campaign_stats stats
    where stats.org_id = p_org;
end;
$function$;
revoke all on function public.civic_campaign_stats_for_org(text) from public, anon, authenticated, service_role;
grant execute on function public.civic_campaign_stats_for_org(text) to authenticated, service_role;

-- get_issue_intelligence_signals
CREATE OR REPLACE FUNCTION public.get_issue_intelligence_signals(p_selected_hat text DEFAULT 'member'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid;
  hat text := coalesce(nullif(pg_catalog.btrim(coalesce(p_selected_hat, '')), ''), 'member');
  staff boolean := false;
  signals jsonb;
  projected jsonb := '[]'::jsonb;
  item jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  org := private.mi1_require_selected_organization();
  if not private.is_organization_member(org) then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  if hat not in ('member', 'steward', 'coordinator', 'admin') then
    raise exception 'invalid hat' using errcode = '22023';
  end if;
  if hat <> 'member' then
    staff := private.has_organization_role(org, array[hat])
      or exists (
        select 1 from public.chapters c
        where c.organization_id = org
          and private.member_has_chapter_role(c.id, array[hat])
      );
    if not staff then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  end if;

  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  if not private.organization_feature_enabled(org, 'features.intelligence.issue_signals') then
    return pg_catalog.jsonb_build_object('enabled', false, 'viewer', case when staff then 'staff' else 'member' end, 'signals', '[]'::jsonb);
  end if;

  signals := private.issue_intelligence_visible_signals(org, pg_catalog.now());
  for item in select value from pg_catalog.jsonb_array_elements(signals) loop
    if staff then
      projected := projected || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'family', item -> 'family',
        'threadKey', item -> 'threadKey',
        'confidence', item -> 'confidence',
        'evidenceFamilies', item -> 'evidenceFamilies',
        'trend', item -> 'trend'
      ));
    else
      projected := projected || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'family', item -> 'family',
        'threadKey', item -> 'threadKey'
      ));
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'enabled', true,
    'viewer', case when staff then 'staff' else 'member' end,
    'windowDays', 30,
    'signals', projected
  );
end;
$function$;
revoke all on function public.get_issue_intelligence_signals(text) from public, anon, authenticated, service_role;
grant execute on function public.get_issue_intelligence_signals(text) to authenticated;

-- get_organization_derived_graph
CREATE OR REPLACE FUNCTION public.get_organization_derived_graph(p_selected_hat text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := private.mi1_require_selected_organization();
  derived_on boolean;
  progress_on boolean;
  floor_size integer;
  edges jsonb := '[]'::jsonb;
  readiness jsonb := '[]'::jsonb;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  -- Same hats as get_organization_intelligence_snapshot.
  if p_selected_hat not in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
     or not private.has_organization_role(org, array[p_selected_hat]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  derived_on := private.organization_feature_enabled(org, 'features.intelligence.neuro_map_derived_graph');
  progress_on := private.organization_feature_enabled(org, 'features.intelligence.neuro_map_auto_progress');
  floor_size := greatest(5, coalesce(private.organization_limit(org, 'limits.intelligence.neuro_map_topic_min_members'), 5));

  if derived_on then
    with visible_cases as (
      select c.id, c.user_id, c.steward_user_id, c.coordinator_user_id, c.case_type, c.articles
      from public.member_cases c
      join public.organization_memberships m
        on m.organization_id = org and m.user_id = c.user_id and m.status = 'active'
      where c.organization_id = org
        and c.status = 'active'
        and private.casework_staff_can_access(c.id)
    ),
    represents as (
      select staff_id as source_id, vc.user_id as target_id, pg_catalog.count(*)::integer as cases
      from visible_cases vc
      cross join lateral (values (vc.steward_user_id), (vc.coordinator_user_id)) as staff(staff_id)
      join public.organization_memberships sm
        on sm.organization_id = org and sm.user_id = staff.staff_id and sm.status = 'active'
      where staff.staff_id is not null and staff.staff_id <> vc.user_id
      group by staff_id, vc.user_id
    ),
    concepts as (
      select distinct vc.user_id, concept
      from visible_cases vc
      cross join lateral pg_catalog.unnest(
        array[pg_catalog.lower(pg_catalog.btrim(coalesce(vc.case_type, '')))] || private.neuro_map_article_concepts(vc.articles)
      ) as concept
      where concept <> '' and concept <> 'other'
    ),
    bounded_concepts as (
      select concept from concepts group by concept having pg_catalog.count(*) between 2 and 12
    ),
    shares as (
      select least(a.user_id, b.user_id) as source_id, greatest(a.user_id, b.user_id) as target_id,
        pg_catalog.count(distinct a.concept)::integer as shared
      from concepts a
      join concepts b on b.concept = a.concept and a.user_id < b.user_id
      join bounded_concepts bc on bc.concept = a.concept
      group by 1, 2
    ),
    all_edges as (
      select 'represents' as kind, r.source_id, r.target_id, least(5, r.cases) as strength from represents r
      union all
      select 'shares_issue', s.source_id, s.target_id, least(5, s.shared) from shares s
    )
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', 'derived:' || e.kind || ':' || e.source_id || ':' || e.target_id,
      'kind', e.kind, 'sourceId', e.source_id, 'targetId', e.target_id, 'strength', e.strength
    ) order by e.kind, e.strength desc, e.source_id, e.target_id), '[]'::jsonb)
    into edges
    from (select * from all_edges order by kind, strength desc, source_id, target_id limit 500) e;
  end if;

  if progress_on then
    with lesson_progress as (
      select l.id as lesson_id, l.label, l.order_index,
        case
          when pg_catalog.jsonb_array_length(l.steps) > 0
            and pg_catalog.cardinality(p.completed_steps) >= pg_catalog.jsonb_array_length(l.steps) then 'ready'
          when pg_catalog.jsonb_array_length(l.steps) > 0
            and pg_catalog.cardinality(p.completed_steps) * 2 >= pg_catalog.jsonb_array_length(l.steps) then 'developing'
          else 'introduced' end as state
      from public.member_rights_progress p
      join public.member_rights_lessons l on l.id = p.lesson_id
      join public.organization_memberships m
        on m.organization_id = org and m.user_id = p.user_id and m.status = 'active'
    ),
    per_lesson as (
      select lesson_id, label, order_index,
        pg_catalog.count(*)::integer as members,
        pg_catalog.count(*) filter (where state = 'introduced')::integer as introduced,
        pg_catalog.count(*) filter (where state = 'developing')::integer as developing,
        pg_catalog.count(*) filter (where state = 'ready')::integer as ready
      from lesson_progress
      group by lesson_id, label, order_index
      having pg_catalog.count(*) >= floor_size
    )
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'topicKey', 'rights-' || pg_catalog.left(pg_catalog.md5(pl.lesson_id), 12),
      'topicLabel', pl.label,
      'members', pl.members, 'introduced', pl.introduced, 'developing', pl.developing, 'ready', pl.ready
    ) order by pl.order_index, pl.label), '[]'::jsonb)
    into readiness
    from per_lesson pl;
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'derivedEnabled', derived_on,
    'autoProgressEnabled', progress_on,
    'edges', edges,
    'topicReadiness', readiness
  );
end;
$function$;
revoke all on function public.get_organization_derived_graph(text) from public, anon, authenticated, service_role;
grant execute on function public.get_organization_derived_graph(text) to authenticated;

-- get_steward_workload_intelligence
CREATE OR REPLACE FUNCTION public.get_steward_workload_intelligence(p_weeks integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  weeks integer := greatest(2, least(coalesce(p_weeks, 12), 52));
  eligible_points integer := 0;
  trends jsonb := '[]'::jsonb;
  balancing jsonb;
  reason text;
begin
  if caller is null or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if caller_chapter is null then
    return pg_catalog.jsonb_build_object(
      'available', false, 'reason', 'chapter_unavailable', 'eligibleWeeks', 0,
      'categories', '[]'::jsonb, 'rebalancing', pg_catalog.jsonb_build_object('stewards', '[]'::jsonb, 'suggestions', '[]'::jsonb));
  end if;
  if not private.member_has_chapter_role(
    caller_chapter,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  if private.chapter_belongs_to_platform(caller_chapter) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  balancing := private.workload_rebalancing(caller_chapter);

  with latest_weekly as materialized (
    select distinct on (pg_catalog.date_trunc('week', w.created_at), w.user_id)
      pg_catalog.date_trunc('week', w.created_at)::date as week_start, w.user_id,
      least(w.priority, 150) as priority, least(w.pending, 150) as pending,
      least(w.unread_docs, 150) as unread_docs, least(w.todos, 150) as todos,
      least(w.referrals, 150) as referrals, least(w.ce_activities, 150) as ce_activities,
      least(w.assistance_requests, 150) as assistance_requests,
      least(w.aged_cases, 150) as aged_cases
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and w.created_at >= pg_catalog.date_trunc('week', pg_catalog.now()) - pg_catalog.make_interval(weeks => weeks)
    order by pg_catalog.date_trunc('week', w.created_at), w.user_id, w.created_at desc
  ), eligible_weeks as materialized (
    select week_start
    from latest_weekly
    group by week_start
    having pg_catalog.count(distinct user_id) >= 25
  )
  select pg_catalog.count(*) into eligible_points from eligible_weeks;

  if eligible_points >= 2 then
    with latest_weekly as materialized (
      select distinct on (pg_catalog.date_trunc('week', w.created_at), w.user_id)
        pg_catalog.date_trunc('week', w.created_at)::date as week_start, w.user_id,
        least(w.priority, 150) as priority, least(w.pending, 150) as pending,
        least(w.unread_docs, 150) as unread_docs, least(w.todos, 150) as todos,
        least(w.referrals, 150) as referrals, least(w.ce_activities, 150) as ce_activities,
        least(w.assistance_requests, 150) as assistance_requests,
        least(w.aged_cases, 150) as aged_cases
      from public.member_workload_logs w
      join public.member_profiles p on p.id = w.user_id
      where p.chapter_id = caller_chapter
        and w.created_at >= pg_catalog.date_trunc('week', pg_catalog.now()) - pg_catalog.make_interval(weeks => weeks)
      order by pg_catalog.date_trunc('week', w.created_at), w.user_id, w.created_at desc
    ), eligible as (
      select week_start from latest_weekly group by week_start
      having pg_catalog.count(distinct user_id) >= 25
    ), weekly_categories as (
      select l.week_start, v.key, v.ord, pg_catalog.avg(v.value)::numeric as value
      from latest_weekly l join eligible e using (week_start)
      cross join lateral (values
        ('priority', 1, l.priority), ('pending', 2, l.pending),
        ('unread_docs', 3, l.unread_docs), ('todos', 4, l.todos),
        ('referrals', 5, l.referrals), ('ce_activities', 6, l.ce_activities),
        ('assistance_requests', 7, l.assistance_requests), ('aged_cases', 8, l.aged_cases)
      ) v(key, ord, value)
      group by l.week_start, v.key, v.ord
    ), regression as (
      select key, ord, pg_catalog.count(*)::integer as points,
        pg_catalog.regr_slope(value, extract(epoch from week_start) / 604800.0)::numeric as slope,
        (pg_catalog.array_agg(value order by week_start desc))[1] as latest
      from weekly_categories group by key, ord
    )
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'key', key, 'points', points,
      'slope', pg_catalog.round(slope, 2),
      'latest', pg_catalog.round(latest, 1),
      'forecast4Weeks', pg_catalog.round(greatest(latest + slope * 4, 0), 1)) order by ord)
    into trends from regression;
  else
    reason := case when eligible_points = 0 then 'anonymity_floor' else 'insufficient_weeks' end;
  end if;

  return pg_catalog.jsonb_build_object(
    'available', eligible_points >= 2,
    'reason', reason,
    'eligibleWeeks', eligible_points,
    'categories', coalesce(trends, '[]'::jsonb),
    'rebalancing', balancing,
    'generatedAt', pg_catalog.now());
end;
$function$;
revoke all on function public.get_steward_workload_intelligence(integer) from public, anon, authenticated, service_role;
grant execute on function public.get_steward_workload_intelligence(integer) to authenticated;

-- Round 8 results boundaries. Each reader below keeps its installed body and
-- adds only private.organization_is_platform, the one kind predicate shared by
-- these repairs: a refusal where the caller's organization is the platform, or
-- a row filter where the counted case belongs to it. Rows without an owning
-- organization (legacy chapters) are not platform rows and keep counting.

-- Platform results boundary: private.casework_dashboard_require_staff (re-emitted from 20260917142000_case_dashboard_aggregates)
create or replace function private.casework_dashboard_require_staff()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if (select auth.uid()) is null
    or not private.mfa_satisfied()
    or private.current_member_organization() is null
    or private.current_member_chapter() is null
    or not private.actor_has_chapter_staff_role(
      (select auth.uid()),
      private.current_member_chapter()
    )
  then
    raise exception 'chapter staff role required' using errcode = '42501';
  end if;
  if private.organization_is_platform(private.current_member_organization()) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
end;
$function$;

-- Platform results boundary: private.casework_dashboard_open_cases (re-emitted from 20261022053100_coordinator_desk_cross_organization_grants)
create or replace function private.casework_dashboard_open_cases()
returns table (
  case_id uuid,
  step_name text,
  steward_id uuid,
  steward_label text,
  coordinator_id uuid,
  coordinator_label text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    c.id,
    c.step,
    c.steward_user_id,
    c.steward_name,
    c.coordinator_user_id,
    c.coordinator_name
  from public.member_cases c
  where c.status = 'active'
    and c.organization_id is not null
    and c.chapter_id is not null
    and (
      (c.organization_id = (select private.current_member_organization())
        and c.chapter_id = (select private.current_member_chapter()))
      or (
        c.id in (
          select g.case_id
          from public.casework_access_grants g
          where g.grantee_user_id = (select auth.uid())
            and g.revoked_at is null
        )
        and public.staff_can_see_user(c.user_id, 'coordinator')
        and private.casework_staff_can_access(c.id)
      )
    )
    and private.casework_staff_can_access(c.id)
    and not private.organization_is_platform(c.organization_id);
$function$;

-- Platform results boundary: public.casework_dashboard_median_days_per_step (re-emitted from 20261022171901_coordinator_desk_grant_scope_median_and_compass_outcomes)
create or replace function public.casework_dashboard_median_days_per_step()
returns table (step text, median_days numeric, transition_count bigint)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.casework_dashboard_require_staff();
  return query
  with tenant as (
    select distinct transition.case_id
    from public.casework_step_transitions transition
    where transition.created_at >= pg_catalog.now() - interval '90 days'
      and (
        (transition.organization_id = (select private.current_member_organization())
          and transition.chapter_id = (select private.current_member_chapter()))
        or (
          transition.case_id in (
            select g.case_id
            from public.casework_access_grants g
            where g.grantee_user_id = (select auth.uid())
              and g.revoked_at is null
          )
          and public.staff_can_see_user((select c.user_id from public.member_cases c where c.id = transition.case_id), 'coordinator')
        )
      )
  ),
  visible as (
    select tenant.case_id
    from tenant
    where private.casework_staff_can_access(tenant.case_id)
      and not private.organization_is_platform(
        (select c.organization_id from public.member_cases c where c.id = tenant.case_id))
  ),
  history as (
    select
      transition.case_id,
      transition.from_step,
      transition.created_at,
      lag(transition.created_at) over (
        partition by transition.case_id
        order by transition.created_at, transition.id
      ) as entered_at
    from public.casework_step_transitions transition
    join visible on visible.case_id = transition.case_id
  ),
  measured as (
    select
      history.from_step,
      extract(epoch from (
        history.created_at - coalesce(history.entered_at, opened.created_at)
      )) / 86400.0 as days_in_step
    from history
    join public.member_cases opened on opened.id = history.case_id
    where history.created_at >= pg_catalog.now() - interval '90 days'
  )
  select
    measured.from_step,
    pg_catalog.round(
      (pg_catalog.percentile_cont(0.5) within group (order by measured.days_in_step))::numeric,
      2
    ),
    pg_catalog.count(*)
  from measured
  group by measured.from_step
  order by pg_catalog.count(*) desc, measured.from_step asc;
end;
$function$;

revoke all on function private.casework_dashboard_require_staff()
  from public, anon, authenticated, service_role;
revoke all on function private.casework_dashboard_open_cases()
  from public, anon, authenticated, service_role;
revoke all on function public.casework_dashboard_median_days_per_step()
  from public, anon, service_role;
grant execute on function public.casework_dashboard_median_days_per_step() to authenticated;

-- Platform results boundary: public.get_compass_staff_data_context (re-emitted from 20261022171901_coordinator_desk_grant_scope_median_and_compass_outcomes)
create or replace function public.get_compass_staff_data_context(p_topics text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
declare
  caller uuid;
  org uuid;
  chapter text;
  topics text[];
  data jsonb;
  part jsonb;
  tally jsonb;
  snapshot jsonb;
  snapshot_read boolean;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'sign in required' using errcode = '42501';
  end if;
  -- The Compass organization: the quota organization the dispatch gate binds.
  org := private.member_organization_for(caller);
  chapter := private.current_member_chapter();
  if org is null
     or not (
       private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
       or private.actor_has_chapter_staff_role(caller, chapter)
     ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if private.organization_is_platform(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.ai_assistant.enabled')
     or not private.organization_feature_enabled(org, 'features.ai_assistant.staff_data_answers') then
    raise exception 'staff data answers are turned off' using errcode = '55000';
  end if;
  data := '{}'::jsonb;
  snapshot_read := false;

  select coalesce(pg_catalog.array_agg(distinct topic order by topic), array[]::text[]) into topics
  from pg_catalog.unnest(coalesce(p_topics, array[]::text[])) topic;
  if pg_catalog.cardinality(topics) not between 1 and 5
     or not topics <@ array['caseload', 'outcomes', 'membership', 'health', 'bargaining'] then
    raise exception 'topics invalid' using errcode = '22023';
  end if;

  if 'caseload' = any(topics) then
    begin
      select pg_catalog.jsonb_build_object(
        'openByStep', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'step', s.step, 'cases', s.case_count) order by s.case_count desc, s.step), '[]'::jsonb)
          from public.casework_dashboard_open_cases_by_step() s),
        'overdue', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'kind', o.kind, 'deadlines', o.deadline_count, 'cases', o.case_count,
            'oldestDaysOverdue', pg_catalog.floor(extract(epoch from (pg_catalog.now() - o.oldest_due_at)) / 86400.0)::integer
          ) order by o.kind), '[]'::jsonb)
          from public.casework_dashboard_overdue_deadlines() o),
        'dueSoon', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'daysOut', d.days_out, 'deadlines', d.deadline_count, 'cases', d.case_count) order by d.days_out), '[]'::jsonb)
          from public.casework_dashboard_deadlines_due_soon() d),
        'medianDaysPerStep', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'step', m.step, 'medianDays', m.median_days, 'transitions', m.transition_count) order by m.step), '[]'::jsonb)
          from public.casework_dashboard_median_days_per_step() m)
      ) into part;
    exception when insufficient_privilege then
      part := pg_catalog.jsonb_build_object('unavailable', true);
    end;
    data := data || pg_catalog.jsonb_build_object('caseload', part);
  end if;

  if 'outcomes' = any(topics) then
    begin
      part := public.get_coordinator_kpis();
      part := pg_catalog.jsonb_build_object(
        'openCases', part -> 'openCases', 'resolved', part -> 'resolved',
        'resolutionRate', part -> 'resolutionRate', 'inArbitration', part -> 'inArbitration',
        'byStep', part -> 'byStep', 'byArticle', part -> 'byArticle');
      -- Recorded outcomes under get_coordinator_kpis' own two bounds (tenant:
      -- the caller's organization and chapter, or a case the caller holds an
      -- active grant for while staff_can_see_user admits them (20261022171901,
      -- #5748); visibility:
      -- private.casework_staff_can_access per case), reached only after that
      -- coordinator-only call succeeded. The bucket is the closed outcome
      -- vocabulary, never the summary.
      select coalesce(pg_catalog.jsonb_object_agg(counted.outcome, counted.total), '{}'::jsonb) into tally
      from (
        select outcome_row.outcome, pg_catalog.count(*) as total
        from public.member_case_outcomes outcome_row
        join public.member_cases case_row on case_row.id = outcome_row.case_id
        where (
            (case_row.organization_id = org and case_row.chapter_id = chapter)
            or (
              case_row.id in (
                select g.case_id
                from public.casework_access_grants g
                where g.grantee_user_id = (select auth.uid())
                  and g.revoked_at is null
              )
              and public.staff_can_see_user(case_row.user_id, 'coordinator')
            )
          )
          and private.casework_staff_can_access(case_row.id)
          and not private.organization_is_platform(case_row.organization_id)
        group by outcome_row.outcome
      ) counted;
      part := part || pg_catalog.jsonb_build_object('byOutcome', tally);
    exception when insufficient_privilege then
      part := pg_catalog.jsonb_build_object('unavailable', true);
    end;
    data := data || pg_catalog.jsonb_build_object('outcomes', part);
  end if;

  if 'membership' = any(topics) or 'health' = any(topics) then
    begin
      snapshot := public.get_organization_analytics_snapshot();
      snapshot_read := (snapshot ->> 'organizationId')::uuid is not distinct from org;
    exception when others then
      snapshot_read := false;
    end;
  end if;

  if 'membership' = any(topics) then
    data := data || pg_catalog.jsonb_build_object('membership', case when snapshot_read then
      pg_catalog.jsonb_build_object(
        'privacyThreshold', snapshot -> 'privacyThreshold',
        'chapters', snapshot -> 'chapters',
        'usageWindows', snapshot -> 'usageWindows')
      else pg_catalog.jsonb_build_object('unavailable', true) end);
  end if;

  if 'health' = any(topics) then
    begin
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'chapterId', item ->> 'chapterId', 'label', item ->> 'chapterName',
          'memberCount', item -> 'memberCount', 'score', item -> 'score',
          'drivers', item -> 'drivers',
          'trend', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'measuredOn', point ->> 'measuredOn', 'score', point -> 'score')), '[]'::jsonb)
            from pg_catalog.jsonb_array_elements(coalesce(item -> 'trend', '[]'::jsonb)) point)
        )), '[]'::jsonb) into part
      from pg_catalog.jsonb_array_elements(coalesce(public.get_chapter_health_portfolio(), '[]'::jsonb)) item
      join public.chapters chapter on chapter.id = item ->> 'chapterId' and chapter.organization_id = org;
    exception when insufficient_privilege then
      part := null;
    end;
    data := data || pg_catalog.jsonb_build_object('health', pg_catalog.jsonb_build_object(
      'privacyThreshold', case when snapshot_read then snapshot -> 'privacyThreshold' else null end,
      'chapters', coalesce(part, '[]'::jsonb),
      'series', case when snapshot_read then snapshot -> 'series' else '[]'::jsonb end,
      'chapterLabels', case when snapshot_read then (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', chapter_row ->> 'id', 'label', chapter_row ->> 'label')), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(coalesce(snapshot -> 'chapters', '[]'::jsonb)) chapter_row
      ) else '[]'::jsonb end,
      'engagementCounts', case when snapshot_read then snapshot -> 'engagementCounts' else '[]'::jsonb end,
      'unavailable', part is null and not snapshot_read));
  end if;

  if 'bargaining' = any(topics) then
    -- Status counts over the workspaces the caller could read: the
    -- casework_bargaining_*_staff policy predicate (chapter staff of the
    -- workspace's chapter), applied explicitly. Titles and bodies are never read.
    select pg_catalog.jsonb_build_object(
      'workspacesByStatus', coalesce((
        select pg_catalog.jsonb_object_agg(counted.status, counted.total)
        from (
          select workspace.status, pg_catalog.count(*) as total
          from public.casework_bargaining_workspaces workspace
          where workspace.organization_id = org
            and private.member_has_chapter_role(workspace.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
          group by workspace.status
        ) counted), '{}'::jsonb),
      'proposalsBySideAndStatus', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'side', counted.side, 'status', counted.status, 'proposals', counted.total)
          order by counted.side, counted.status)
        from (
          select proposal.side, proposal.status, pg_catalog.count(*) as total
          from public.casework_bargaining_proposals proposal
          join public.casework_bargaining_workspaces workspace
            on workspace.id = proposal.workspace_id and workspace.organization_id = proposal.organization_id
          where proposal.organization_id = org
            and private.member_has_chapter_role(workspace.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
          group by proposal.side, proposal.status
        ) counted), '[]'::jsonb),
      'responsesDueWithin7Days', (
        select pg_catalog.count(*)
        from public.casework_bargaining_proposals proposal
        join public.casework_bargaining_workspaces workspace
          on workspace.id = proposal.workspace_id and workspace.organization_id = proposal.organization_id
        where proposal.organization_id = org
          and private.member_has_chapter_role(workspace.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
          and proposal.status in ('proposed', 'countered')
          and proposal.response_due_at >= pg_catalog.now()
          and proposal.response_due_at < pg_catalog.now() + interval '7 days'),
      'responsesOverdue', (
        select pg_catalog.count(*)
        from public.casework_bargaining_proposals proposal
        join public.casework_bargaining_workspaces workspace
          on workspace.id = proposal.workspace_id and workspace.organization_id = proposal.organization_id
        where proposal.organization_id = org
          and private.member_has_chapter_role(workspace.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
          and proposal.status in ('proposed', 'countered')
          and proposal.response_due_at < pg_catalog.now())
    ) into part;
    data := data || pg_catalog.jsonb_build_object('bargaining', part);
  end if;

  return pg_catalog.jsonb_build_object('organization_id', org, 'topics', pg_catalog.to_jsonb(topics), 'data', data);
end;
end;
$function$;

revoke all on function public.get_compass_staff_data_context(text[]) from public, anon, authenticated, service_role;
grant execute on function public.get_compass_staff_data_context(text[]) to authenticated;

-- Platform results boundary: private.workload_rebalancing (re-emitted from 20260901162845_sample_staff_rpc_tenant_authorization)
create or replace function private.workload_rebalancing(p_chapter text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with chapter_scope as materialized (
    select c.organization_id
    from public.chapters c
    where c.id = p_chapter
  ), steward_roster as materialized (
    select distinct p.id as steward_id, p.full_name
    from public.member_profiles p
    cross join chapter_scope
    where p.chapter_id = p_chapter
      and (
        (
          chapter_scope.organization_id is not null
          and private.organization_member_roles(
            p.id,
            chapter_scope.organization_id,
            p_chapter
          ) ? 'steward'
        )
        or (
          chapter_scope.organization_id is null
          and exists (
            select 1
            from public.member_roles legacy_role
            where legacy_role.user_id = p.id
              and legacy_role.role = 'steward'
              and (legacy_role.chapter_id is null or legacy_role.chapter_id = p_chapter)
          )
        )
      )
    order by p.full_name, p.id
    limit 50
  ), counts as (
    select s.steward_id, s.full_name,
      pg_catalog.count(c.id)::integer as active,
      pg_catalog.count(c.id) filter (
        where c.deadline between current_date and current_date + 6)::integer as due_soon,
      pg_catalog.count(c.id) filter (where c.deadline < current_date)::integer as overdue
    from steward_roster s
    left join public.member_cases c on c.steward_user_id = s.steward_id
      and c.status = 'active'
      and not private.organization_is_platform(c.organization_id)
      and exists (
        select 1 from public.member_profiles owner
        where owner.id = c.user_id and owner.chapter_id = p_chapter)
    group by s.steward_id, s.full_name
  ), mean as (
    select coalesce(pg_catalog.avg(active), 0) as avg_active from counts
  ), ranked_high as (
    select c.*, pg_catalog.row_number() over (order by active desc, overdue desc, steward_id) as rn
    from counts c, mean m where c.active >= pg_catalog.ceil(m.avg_active)::integer + 2
  ), ranked_low as (
    select c.*, pg_catalog.row_number() over (order by active asc, overdue asc, steward_id) as rn
    from counts c, mean m where c.active <= greatest(pg_catalog.floor(m.avg_active)::integer - 1, 0)
  ), suggestions as (
    select h.steward_id as from_id, h.full_name as from_name,
      l.steward_id as to_id, l.full_name as to_name,
      least(greatest((h.active - l.active) / 2, 1), 10)::integer as review_count,
      h.active as from_active, l.active as to_active
    from ranked_high h join ranked_low l using (rn)
    where h.steward_id <> l.steward_id
    order by h.active desc, l.active asc, h.steward_id, l.steward_id
    limit 10
  )
  select pg_catalog.jsonb_build_object(
    'stewards', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', c.steward_id, 'name', c.full_name, 'activeCases', c.active,
      'dueSoon', c.due_soon, 'overdue', c.overdue) order by c.full_name, c.steward_id) from counts c), '[]'::jsonb),
    'suggestions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'fromUserId', s.from_id, 'fromName', s.from_name,
      'toUserId', s.to_id, 'toName', s.to_name,
      'reviewCount', s.review_count, 'fromActiveCases', s.from_active,
      'toActiveCases', s.to_active) order by s.from_active desc, s.from_id) from suggestions s), '[]'::jsonb)
  );
$function$;

revoke all on function private.workload_rebalancing(text)
  from public, anon, authenticated, service_role;

-- Platform results boundary: public.list_constant_contact_analytics (re-emitted from 20260830233000_constant_contact_integration)
create or replace function public.list_constant_contact_analytics(p_limit integer default 25)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  page_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if private.organization_is_platform(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'memberId', analytics.member_id,
      'memberName', coalesce(nullif(pg_catalog.btrim(profile.full_name), ''), 'Member'),
      'contactStatus', analytics.contact_status,
      'listCount', analytics.list_count, 'tagCount', analytics.tag_count,
      'sendsCount', analytics.sends_count, 'opensCount', analytics.opens_count,
      'clicksCount', analytics.clicks_count, 'bouncesCount', analytics.bounces_count,
      'optoutsCount', analytics.optouts_count, 'forwardsCount', analytics.forwards_count,
      'lastActivityAt', analytics.last_activity_at, 'syncedAt', analytics.synced_at
    ) order by analytics.last_activity_at desc nulls last, analytics.member_id)
    from (
      select source.* from public.constant_contact_member_analytics source
      where source.organization_id = org
      order by source.last_activity_at desc nulls last, source.member_id
      limit page_limit
    ) analytics
    left join public.member_profiles profile on profile.id = analytics.member_id
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_constant_contact_analytics(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_constant_contact_analytics(integer) to authenticated;

-- Platform results boundary: public.list_constant_contact_control (re-emitted from 20260830233000_constant_contact_integration)
-- Operational controls stay readable; the five analytics aggregates are
-- withheld (null) for the platform, matching the list_constant_contact_analytics refusal.
create or replace function public.list_constant_contact_control()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  withheld boolean;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  withheld := private.organization_is_platform(org);
  return pg_catalog.jsonb_build_object(
    'status', coalesce((select integration.status from public.organization_integrations integration
      where integration.organization_id = org and integration.provider = 'constant_contact'), 'unset'),
    'connected', exists (select 1 from private.constant_contact_oauth_tokens token
      where token.organization_id = org and token.status = 'connected'),
    'accountLabel', (select token.account_label from private.constant_contact_oauth_tokens token
      where token.organization_id = org),
    'scope', (select token.scope from private.constant_contact_oauth_tokens token
      where token.organization_id = org),
    'lastSyncAt', (select token.last_sync_at from private.constant_contact_oauth_tokens token
      where token.organization_id = org),
    'lastErrorCode', (select token.last_error_code from private.constant_contact_oauth_tokens token
      where token.organization_id = org),
    'memberCount', case when withheld then null else (select pg_catalog.count(*) from public.constant_contact_member_analytics analytics
      where analytics.organization_id = org) end,
    'activeContactCount', case when withheld then null else (select pg_catalog.count(*) from public.constant_contact_member_analytics analytics
      where analytics.organization_id = org and analytics.contact_status = 'active') end,
    'sendCount', case when withheld then null else (select coalesce(pg_catalog.sum(analytics.sends_count), 0) from public.constant_contact_member_analytics analytics
      where analytics.organization_id = org) end,
    'openCount', case when withheld then null else (select coalesce(pg_catalog.sum(analytics.opens_count), 0) from public.constant_contact_member_analytics analytics
      where analytics.organization_id = org) end,
    'clickCount', case when withheld then null else (select coalesce(pg_catalog.sum(analytics.clicks_count), 0) from public.constant_contact_member_analytics analytics
      where analytics.organization_id = org) end
  );
end;
$function$;
revoke all on function public.list_constant_contact_control()
  from public, anon, authenticated, service_role;
grant execute on function public.list_constant_contact_control() to authenticated;

-- Platform results boundary: public.list_contract_clause_grievance_counts (re-emitted from 20261003040000_member_pin_signin)
-- Only the platform refusal is new; the per-article counts are platform results (#5813 round 10).
create or replace function public.list_contract_clause_grievance_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();

declare
  org uuid := private.mi1_require_selected_organization();
  v_actor uuid := (select auth.uid());
  staff boolean;
  steward_hat boolean;
  coordinator_chapters text[];
  staff_organization uuid;
  organization_officer boolean;
  granted_cases uuid[];
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- A platform organization's per-article case counts are platform results.
  if private.organization_is_platform(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  -- Same clause visibility as public.list_contract_clauses.
  staff := private.has_organization_role(
    org,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  );

  -- Caller-only inputs of the member_cases SELECT policies, resolved once.
  -- mfa_assurance is already satisfied by the gate above.
  steward_hat := coalesce(public.member_has_role(array['steward']), false);
  coordinator_chapters := array(select private.staff_visible_chapter_scope('coordinator'));
  staff_organization := private.current_mobile_staff_organization();
  organization_officer := coalesce(
    private.has_organization_role(staff_organization, array['advisor', 'admin', 'vp']),
    false
  );
  granted_cases := array(
    select g.case_id
    from public.casework_access_grants g
    where g.grantee_user_id = v_actor
      and g.revoked_at is null
  );

  -- Each visible case's articles are normalized and split into tokens ONCE,
  -- then joined to the caller-visible clause articles on equality. The
  -- 20260925110500 body re-ran the regexp_replace for every (clause, case)
  -- pair as a LIKE join filter, so its cost grew with clauses x cases.
  return coalesce((
    with visible_cases as (
      select cs.id,
             ',' || pg_catalog.regexp_replace(
               pg_catalog.lower(pg_catalog.btrim(cs.articles)),
               '[[:space:]]*[,;/]+[[:space:]]*',
               ',',
               'g'
             ) || ',' as line
      from public.member_cases cs
      left join public.member_profiles case_owner
        on coordinator_chapters <> '{}'::text[]
       and case_owner.id = cs.user_id
      where cs.organization_id = org
        and cs.articles is not null
        and pg_catalog.btrim(cs.articles) <> ''
        and (
          -- member_cases_select_own
          cs.user_id = v_actor
          -- member_cases_select_steward
          or (cs.steward_user_id = v_actor and steward_hat)
          -- member_cases_select_coordinator
          or (
            case_owner.chapter_id = any(coordinator_chapters)
            and (
              not cs.is_restricted
              or cs.coordinator_user_id = v_actor
              or (
                cs.organization_id is not null
                and cs.organization_id = staff_organization
                and organization_officer
              )
              or cs.id = any(granted_cases)
            )
          )
        )
    ),
    case_articles as (
      select v.id as case_id, token.article
      from visible_cases v
      cross join lateral pg_catalog.unnest(
        pg_catalog.string_to_array(pg_catalog.btrim(v.line, ','), ',')
      ) as token(article)
      where token.article <> ''
    ),
    -- Counted per token before the clause join and materialized, so the join
    -- only ever sees distinct tokens: the planner cannot rescan member_cases
    -- (or re-run the regexp) once per clause article when statistics are thin.
    token_counts as materialized (
      select ca.article, pg_catalog.count(distinct ca.case_id)::integer as n
      from case_articles ca
      group by ca.article
    ),
    visible_articles as (
      select distinct pg_catalog.lower(pg_catalog.btrim(c.article)) as article
      from public.contract_clauses c
      where c.organization_id = org
        and (staff or c.status = 'published')
    )
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'article', counts.article,
      'count', counts.n
    ) order by counts.article)
    from (
      select a.article, t.n
      from visible_articles a
      join token_counts t on t.article = a.article
    ) counts
  ), '[]'::jsonb);
end;

end;
$function$;


insert into private.account_lifecycle_trigger_review
  (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where object_name in ('b10_organization_kind', 'b15_platform_organization_boundary')
   or object_name like 'enforce_organization_kind(%'
   or object_name like 'enforce_platform_organization_boundary(%'
   or (kind = 'function' and schema_name = 'private' and object_name = 'enforce_unverified_organization_boundary()')
   or (kind = 'function' and schema_name in ('public','private') and pg_catalog.split_part(object_name,'(',1) in ('organization_clears_signup_boundary','toggle_digital_action_participation','get_issue_intelligence_signals','get_steward_workload_intelligence','get_organization_derived_graph','civic_campaign_stats_for_org','get_workload_stats','can_manage_chapter_health','generate_issue_intelligence_weekly_digests','issue_digest_staff_organization','get_public_site_content','get_public_directory','get_public_event_detail','submit_public_event_rsvp','get_public_chapter_microsite','get_organization_public_verification','organization_network_can_discover','organization_network_has_permission','list_chapter_connection_profiles','compass_retrieval_scope_summary','generate_analytics_usage_digests','submit_organization_claim','get_organization_analytics_snapshot','get_organization_analytics_workspace','request_organization_analytics_export','get_organization_catalog_verification','usage_digest_staff_organization','record_workspace_page_view','organization_is_union','chapter_belongs_to_union','chapter_belongs_to_platform','organization_is_platform','casework_dashboard_require_staff','casework_dashboard_open_cases','casework_dashboard_median_days_per_step','get_compass_staff_data_context','workload_rebalancing','list_constant_contact_analytics','list_constant_contact_control','list_contract_clause_grievance_counts','request_filtered_organization_export','export_organization_survey_results','export_organization_survey_window','get_bargaining_survey_results','get_organization_survey_report','get_organization_survey_report_window','get_organization_survey_review_detail','get_organization_survey_worksites','request_digital_action_participant_export','casework_record_case_export','get_ballot_tally','get_channel_poll_tally','chapter_task_report','get_vp_overview','get_advisor_overview','get_officer_removal_ballot_details','verify_ballot_receipt','organization_export_dataset','run_organization_coordination_export','get_organization_coordination_export_payload','run_due_organization_coordination_exports','claim_organization_export_deliveries','complete_organization_export_delivery','engagement_member_snapshot_scoped','staff_engagement_survey_page','get_collective_actions','get_staff_engagement_snapshot','get_coordinator_kpis','get_organization_coordination_snapshot','list_organization_coordination_records','list_organization_coordination_messages'))
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

notify pgrst, 'reload schema';
commit;
