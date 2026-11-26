-- REQ-UG-COMPASS-SCOPE-RESOLVER-20261003
-- Scope is an ingestion property, never a client-selected retrieval argument.
-- Chapter memberships supply the member's agency/unit ancestry through an
-- explicitly sourced operator binding. Chart labels and context-only cross
-- references do not grant scope. Unbound chapters retain their exact chapter
-- boundary; unresolved legacy ownership stays unavailable.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.compass_chapter_scope_bindings (
  chapter_id text primary key references public.chapters(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  agency_key text,
  unit_keys text[] not null default '{}',
  provenance jsonb not null,
  constraint compass_scope_agency_key check (
    agency_key is null or agency_key ~ '^[a-z0-9][a-z0-9:._/-]{0,119}$'),
  constraint compass_scope_unit_key check (
    pg_catalog.cardinality(unit_keys) between 0 and 32
    and pg_catalog.array_position(unit_keys, null) is null
    and (pg_catalog.cardinality(unit_keys) = 0 or agency_key is not null)),
  constraint compass_scope_provenance check (
    provenance ?& array['source', 'sha256']
    and pg_catalog.jsonb_typeof(provenance) = 'object'
    and pg_catalog.jsonb_typeof(provenance -> 'source') = 'string'
    and pg_catalog.char_length(provenance ->> 'source') between 1 and 1000
    and (provenance ->> 'sha256') ~ '^[0-9a-f]{64}$')
);
alter table private.compass_chapter_scope_bindings enable row level security;
alter table private.compass_chapter_scope_bindings force row level security;
revoke all on table private.compass_chapter_scope_bindings from public, anon, authenticated;
grant select, insert, update, delete on table private.compass_chapter_scope_bindings to service_role;

create trigger a00_case_graph_lock before insert or update or delete on private.compass_chapter_scope_bindings
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.compass_chapter_scope_bindings
for each row execute function private.lock_case_graph_row_keys('', '');

create function private.compass_scope_binding_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare chapter_org uuid; unit text;
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  select c.organization_id into chapter_org from public.chapters c where c.id = new.chapter_id;
  if chapter_org is null or chapter_org is distinct from new.organization_id then
    raise exception 'scope binding must name the chapter organization' using errcode = '22023';
  end if;
  foreach unit in array new.unit_keys loop
    if unit !~ '^[a-z0-9][a-z0-9:._/-]{0,119}$' then
      raise exception 'invalid canonical unit key' using errcode = '22023';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function private.compass_scope_binding_guard() from public, anon, authenticated, service_role;
create trigger compass_scope_binding_guard before insert or update
  on private.compass_chapter_scope_bindings for each row execute function private.compass_scope_binding_guard();

-- National identity is contextual ancestry from a verified local identity and
-- a filed/confirmed catalog edge. It never widens the private organization gate.
create function private.compass_national_scope_key(p_organization_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case when pg_catalog.count(distinct national.catalog_key) = 1
    then pg_catalog.min(national.catalog_key) else null end
  from private.organization_catalog_placements placement
  join private.catalog_edges edge on edge.child_key = placement.identity_catalog_key
    and edge.edge_kind in ('olms_parent', 'parent_body')
    and edge.certainty in ('filed', 'confirmed') and edge.retired_release_id is null
  join private.catalog_organizations national on national.catalog_key = edge.parent_key
    and national.tier = 'national' and national.retired_release_id is null and national.duplicate_of is null
  where placement.organization_id = p_organization_id
    and placement.verification_status = 'verified' and placement.verified_at is not null;
$$;
revoke all on function private.compass_national_scope_key(uuid) from public, anon, authenticated, service_role;

create function private.compass_scope_path_for_chapter(p_chapter_id text, p_level text default 'chapter', p_unit_key text default null)
returns text[] language plpgsql stable security definer set search_path = '' as $$
declare org uuid; binding private.compass_chapter_scope_bindings%rowtype;
  path text[]; national text;
begin
  if p_level is null or p_level not in ('local', 'agency', 'unit', 'chapter') then return '{}'::text[]; end if;
  select c.organization_id into org from public.chapters c where c.id = p_chapter_id;
  if org is null then return '{}'::text[]; end if;
  national := private.compass_national_scope_key(org);
  path := array['organization:' || org::text];
  if national is not null then path := array['national:' || national] || path; end if;
  if p_level = 'local' then return path; end if;
  select b.* into binding from private.compass_chapter_scope_bindings b
    where b.chapter_id = p_chapter_id and b.organization_id = org;
  if binding.agency_key is not null then path := path || ('agency:' || binding.agency_key); end if;
  if p_level = 'agency' then
    return case when binding.agency_key is not null then path else '{}'::text[] end;
  end if;
  path := path || ('chapter:' || p_chapter_id);
  if p_level = 'unit' then
    return case when p_unit_key = any(binding.unit_keys) then path || ('unit:' || p_unit_key) else '{}'::text[] end;
  end if;
  return path;
end;
$$;
revoke all on function private.compass_scope_path_for_chapter(text, text, text) from public, anon;
grant execute on function private.compass_scope_path_for_chapter(text, text, text) to authenticated, service_role;

-- Unit assignments are member metadata on the existing membership ledger, so
-- its existing account erasure and identity graph locks continue to apply.
-- Only an operator can verify them; a chapter's unit list alone is not a claim.
alter table public.member_chapter_memberships
  add column compass_unit_keys text[] not null default '{}'
    check (pg_catalog.cardinality(compass_unit_keys) between 0 and 16 and pg_catalog.array_position(compass_unit_keys, null) is null),
  add column compass_scope_verification jsonb,
  add constraint member_compass_scope_verification check (
    (pg_catalog.cardinality(compass_unit_keys) = 0 and compass_scope_verification is null)
    or (pg_catalog.cardinality(compass_unit_keys) > 0 and compass_scope_verification is not null
      and compass_scope_verification ?& array['source', 'sha256']
      and pg_catalog.jsonb_typeof(compass_scope_verification) = 'object'
      and pg_catalog.jsonb_typeof(compass_scope_verification -> 'source') = 'string'
      and pg_catalog.char_length(compass_scope_verification ->> 'source') between 1 and 1000
      and (compass_scope_verification ->> 'sha256') ~ '^[0-9a-f]{64}$'));

create function private.bind_compass_member_unit_scope()
returns trigger language plpgsql security definer set search_path = '' as $$
declare allowed text[]; unit text; privileged boolean := coalesce((select auth.role()), '') = 'service_role'
  or (coalesce((select auth.role()), '') = '' and (select auth.uid()) is null);
begin
  if not privileged then
    if (tg_op = 'INSERT' and (pg_catalog.cardinality(new.compass_unit_keys) > 0 or new.compass_scope_verification is not null))
      or (tg_op = 'UPDATE' and (new.compass_unit_keys is distinct from old.compass_unit_keys
        or new.compass_scope_verification is distinct from old.compass_scope_verification)) then
      raise exception 'unit membership verification requires the operator' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and (new.user_id is distinct from old.user_id or new.chapter_id is distinct from old.chapter_id
      or (old.status <> 'active' and new.status = 'active')) then
      new.compass_unit_keys := '{}'; new.compass_scope_verification := null;
    end if;
  end if;
  select b.unit_keys into allowed from private.compass_chapter_scope_bindings b
    where b.chapter_id = new.chapter_id;
  foreach unit in array new.compass_unit_keys loop
    if not coalesce(unit = any(allowed), false) then
      raise exception 'unit is not a sourced chapter unit' using errcode = '22023';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function private.bind_compass_member_unit_scope() from public, anon, authenticated, service_role;
create trigger compass_member_unit_scope_binding before insert or update on public.member_chapter_memberships
  for each row execute function private.bind_compass_member_unit_scope();

create function private.compass_member_scope_paths()
returns table(organization_id uuid, chapter_id text, scope_path text[])
language sql stable security definer set search_path = '' as $$
  select chapter.organization_id, chapter.id, private.compass_scope_path_for_chapter(chapter.id, 'chapter')
  from private.compass_quota_organization((select auth.uid())) active
  join public.member_chapter_memberships membership on membership.user_id = (select auth.uid())
    and membership.status = 'active'
  join public.chapters chapter on chapter.id = membership.chapter_id
    and chapter.organization_id = active.organization_id
  where active.resolution = 'selected' and private.mfa_satisfied()
  union all
  select chapter.organization_id, chapter.id, private.compass_scope_path_for_chapter(chapter.id, 'unit', unit.key)
  from private.compass_quota_organization((select auth.uid())) active
  join public.member_chapter_memberships membership on membership.user_id = (select auth.uid()) and membership.status = 'active'
  join public.chapters chapter on chapter.id = membership.chapter_id and chapter.organization_id = active.organization_id
  cross join lateral pg_catalog.unnest(membership.compass_unit_keys) unit(key)
  where active.resolution = 'selected' and private.mfa_satisfied() and membership.compass_scope_verification is not null;
$$;
revoke all on function private.compass_member_scope_paths() from public, anon, service_role;
grant execute on function private.compass_member_scope_paths() to authenticated;

create function private.compass_scope_specificity(p_organization_id uuid, p_path text[], p_level text)
returns integer language plpgsql stable security definer set search_path = '' as $$
declare active_org uuid; resolution text; candidate record; prefix integer; best integer := 0;
  root_depth integer := 1;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() or p_organization_id is null
    or coalesce(pg_catalog.cardinality(p_path), 0) = 0 then return 0; end if;
  select q.organization_id, q.resolution into active_org, resolution
    from private.compass_quota_organization((select auth.uid())) q;
  if active_org is distinct from p_organization_id or resolution <> 'selected' then return 0; end if;
  if p_path[1] like 'national:%' then root_depth := 2; end if;
  if p_path[root_depth] is distinct from 'organization:' || active_org::text then return 0; end if;
  if p_level = 'local' then
    return case when pg_catalog.cardinality(p_path) = root_depth then 1 else 0 end;
  end if;
  if p_level is null or p_level not in ('agency', 'unit', 'chapter') then return 0; end if;
  for candidate in select s.* from private.compass_member_scope_paths() s loop
    if p_level in ('chapter', 'unit') and candidate.scope_path is distinct from p_path then continue; end if;
    prefix := 0;
    for i in 1..least(pg_catalog.cardinality(candidate.scope_path), pg_catalog.cardinality(p_path)) loop
      exit when candidate.scope_path[i] is distinct from p_path[i];
      prefix := i;
    end loop;
    if prefix > root_depth then best := greatest(best, prefix - root_depth + 1); end if;
  end loop;
  return best;
end;
$$;
revoke all on function private.compass_scope_specificity(uuid, text[], text) from public, anon, service_role;
grant execute on function private.compass_scope_specificity(uuid, text[], text) to authenticated;

alter table public.member_kb_articles
  add column compass_organization_id uuid references public.organizations(id) on delete restrict,
  add column compass_scope_level text not null default 'chapter'
    check (compass_scope_level in ('local', 'agency', 'unit', 'chapter')),
  add column compass_scope_unit_key text,
  add column compass_scope_path text[] not null default '{}';
alter table public.member_kb_article_embeddings
  add column compass_organization_id uuid references public.organizations(id) on delete restrict,
  add column compass_scope_path text[] not null default '{}';
create index member_kb_articles_compass_scope_idx on public.member_kb_articles using gin(compass_scope_path);
create index member_kb_embeddings_compass_organization_idx on public.member_kb_article_embeddings(compass_organization_id, article_id);

create function private.bind_compass_article_scope()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Scope broadening is an operator operation. Ordinary publication keeps
  -- chapter scope; submitted organization/path values are always overwritten.
  if (tg_op = 'INSERT' and new.compass_scope_level <> 'chapter')
    or (tg_op = 'INSERT' and new.compass_scope_unit_key is not null)
    or (tg_op = 'UPDATE' and (new.compass_scope_level is distinct from old.compass_scope_level
      or new.compass_scope_unit_key is distinct from old.compass_scope_unit_key)) then
    if not ((select auth.role()) = 'service_role'
      or (coalesce((select auth.role()), '') = '' and (select auth.uid()) is null)) then
      raise exception 'document scope changes require the operator' using errcode = '42501';
    end if;
  end if;
  select c.organization_id into new.compass_organization_id from public.chapters c where c.id = new.chapter_id;
  new.compass_scope_path := private.compass_scope_path_for_chapter(new.chapter_id, new.compass_scope_level, new.compass_scope_unit_key);
  return new;
end;
$$;
revoke all on function private.bind_compass_article_scope() from public, anon, authenticated, service_role;
create trigger compass_article_scope_binding before insert or update on public.member_kb_articles
  for each row execute function private.bind_compass_article_scope();

create function private.bind_compass_embedding_scope()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  select a.compass_organization_id, a.compass_scope_path
    into new.compass_organization_id, new.compass_scope_path
    from public.member_kb_articles a where a.id = new.article_id;
  return new;
end;
$$;
revoke all on function private.bind_compass_embedding_scope() from public, anon, authenticated, service_role;
create trigger compass_embedding_scope_binding before insert or update on public.member_kb_article_embeddings
  for each row execute function private.bind_compass_embedding_scope();

create function private.compass_article_scope_current(a public.member_kb_articles)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(a.compass_organization_id = chapter.organization_id
    and pg_catalog.cardinality(a.compass_scope_path) > 0
    and a.compass_scope_path = private.compass_scope_path_for_chapter(a.chapter_id, a.compass_scope_level, a.compass_scope_unit_key), false)
  from public.chapters chapter where chapter.id = a.chapter_id;
$$;
revoke all on function private.compass_article_scope_current(public.member_kb_articles) from public, anon;
grant execute on function private.compass_article_scope_current(public.member_kb_articles) to authenticated, service_role;

-- Existing rows are intentionally unbound until the bounded scope backfill.
-- Query/RLS definitions and reviewed lifecycle inventory follow below.

create function public.backfill_compass_document_scopes(p_after uuid default null, p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare row record; n integer; scoped integer; unresolved integer;
  chunks integer; changed integer; cursor uuid; path text[];
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  n := 0; scoped := 0; unresolved := 0; chunks := 0;
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception 'invalid limit' using errcode = '22023';
  end if;
  for row in select a.id from public.member_kb_articles a
    where p_after is null or a.id > p_after order by a.id limit p_limit for update loop
    update public.member_kb_articles set compass_scope_path = '{}' where id = row.id
      returning compass_scope_path into path;
    n := n + 1; cursor := row.id;
    if pg_catalog.cardinality(path) > 0 then scoped := scoped + 1; else unresolved := unresolved + 1; end if;
    -- This writes metadata on existing vectors only. Their body/classification
    -- and model gates still decide whether the old chunk is usable.
    update public.member_kb_article_embeddings set compass_scope_path = '{}' where article_id = row.id;
    get diagnostics changed = row_count; chunks := chunks + changed;
  end loop;
  return pg_catalog.jsonb_build_object('selected', n, 'scoped', scoped, 'unresolved', unresolved,
    'chunksWritten', chunks, 'nextCursor', case when n = 0 then null else cursor end);
end;
$$;
revoke all on function public.backfill_compass_document_scopes(uuid, integer) from public, anon, authenticated;
grant execute on function public.backfill_compass_document_scopes(uuid, integer) to service_role;

drop policy if exists member_kb_articles_member_read on public.member_kb_articles;
create policy member_kb_articles_member_read on public.member_kb_articles for select to authenticated
  using (
    private.compass_article_scope_current(member_kb_articles)
    and private.compass_scope_specificity(compass_organization_id, compass_scope_path, compass_scope_level) > 0
    and not is_sample and status = 'published' and verified_by is not null and verified_at is not null
    and private.knowledge_article_content_current(member_kb_articles)
    and private.compass_article_classification_current(member_kb_articles)
  );

comment on policy member_kb_articles_member_read on public.member_kb_articles is
  'Member knowledge reads require the active organization and verified membership scope intersection, current canonical path, publication, source verdict and ingestion classification.';

alter policy member_kb_article_embeddings_member_read on public.member_kb_article_embeddings
  using (
    model = 'bge-m3'
    and digest = 'sha256:7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab'
    and exists (
      select 1 from public.member_kb_articles a where a.id = member_kb_article_embeddings.article_id
        and private.compass_article_scope_current(a)
        and private.compass_scope_specificity(a.compass_organization_id, a.compass_scope_path, a.compass_scope_level) > 0
        and member_kb_article_embeddings.compass_organization_id = a.compass_organization_id
        and member_kb_article_embeddings.compass_scope_path = a.compass_scope_path
        and not a.is_sample and a.status = 'published' and a.verified_by is not null and a.verified_at is not null
        and private.knowledge_article_content_current(a) and private.compass_article_classification_current(a)
        and classification_sha256 = a.compass_classification ->> 'input_sha256'
        and body_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(a.body, 'UTF8')), 'hex')
    )
  );

comment on policy member_kb_article_embeddings_member_read on public.member_kb_article_embeddings is
  'Vector rows inherit the parent article organization and scope path and retain classification, body and pinned model checks; member scope is resolved from active memberships in the database.';

-- Keep new membership metadata in the existing member-owned export domain.
update private.account_lifecycle_manifest
set export_columns = array['user_id','chapter_id','status','pinned','last_selected_at','joined_at','revoked_at',
  'compass_unit_keys','compass_scope_verification']::text[]
where schema_name = 'public' and table_name = 'member_chapter_memberships' and user_column = 'user_id';
create or replace function private.account_lifecycle_export_member_chapter_memberships(p_caller uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'user_id', t.user_id, 'chapter_id', t.chapter_id, 'status', t.status, 'pinned', t.pinned,
    'last_selected_at', t.last_selected_at, 'joined_at', t.joined_at, 'revoked_at', t.revoked_at,
    'compass_unit_keys', t.compass_unit_keys, 'compass_scope_verification', t.compass_scope_verification)), '[]'::jsonb)
  from public.member_chapter_memberships t where t.user_id = p_caller;
$$;
revoke all on function private.account_lifecycle_export_member_chapter_memberships(uuid)
  from public, anon, authenticated, service_role;

create function private.compass_retrieval_scope_summary(p_query text, p_sources jsonb)
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
      join public.organizations organization on organization.id = membership.organization_id and organization.status = 'active'
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
revoke all on function private.compass_retrieval_scope_summary(text, jsonb) from public, anon, service_role;
grant execute on function private.compass_retrieval_scope_summary(text, jsonb) to authenticated;

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
      a.kind,
      a.title,
      a.article_ref as ref,
      pg_catalog.left(a.compass_classification ->> 'text', 320) as snippet,
      case
        when (select ts from q) is null
          then 0.001 * (100 - least(a.order_index, 99))::double precision
        else pg_catalog.ts_rank(
          pg_catalog.to_tsvector(
            'english',
            coalesce(a.title, '') || ' ' || coalesce(a.article_ref, '') || ' ' ||
            coalesce(a.compass_classification ->> 'text', '') || ' ' || pg_catalog.array_to_string(a.keywords, ' ')
          ),
          (select ts from q)
        )
      end as score,
      a.order_index as ord,
      private.compass_scope_specificity(a.compass_organization_id, a.compass_scope_path, a.compass_scope_level) as scope_rank
    from public.member_kb_articles a
    where a.compass_organization_id = (select private.compass_context_organization())
      and private.compass_article_scope_current(a)
      and private.compass_scope_specificity(a.compass_organization_id, a.compass_scope_path, a.compass_scope_level) > 0
      and not a.is_sample
      and a.status = 'published'
      and a.verified_by is not null
      and a.verified_at is not null
      and private.knowledge_article_content_current(a)
      and private.compass_article_classification_current(a)
      and (
        (select ts from q) is null
        or pg_catalog.to_tsvector(
             'english',
             coalesce(a.title, '') || ' ' || coalesce(a.article_ref, '') || ' ' ||
             coalesce(a.compass_classification ->> 'text', '') || ' ' || pg_catalog.array_to_string(a.keywords, ' ')
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
      1000 + l.order_index,
      0 as scope_rank
    from public.member_rights_lessons l
    where (select ts from q) is not null
      and pg_catalog.to_tsvector(
            'english',
            coalesce(l.label, '') || ' ' || coalesce(l.title, '') || ' ' ||
            coalesce(l.description, '') || ' ' || coalesce(l.script, '')
          ) @@ (select ts from q)

    union all

    select
      'doc:' || d.id::text,
      'document',
      d.title,
      'Chapter library · ' || d.document_type,
      pg_catalog.left(coalesce(nullif(pg_catalog.btrim(d.summary), ''), d.body), 320),
      pg_catalog.ts_rank(
        pg_catalog.to_tsvector(
          'english',
          coalesce(d.title, '') || ' ' || coalesce(d.document_type, '') || ' ' ||
          coalesce(d.summary, '') || ' ' || coalesce(d.body, '')
        ),
        (select ts from q)
      ),
      1500,
      private.compass_scope_specificity(private.compass_context_organization(),
        private.compass_scope_path_for_chapter(d.chapter_id), 'chapter') as scope_rank
    from public.chapter_documents d
    where (select ts from q) is not null
      and d.chapter_id = private.current_member_chapter()
      and d.status = 'published'
      and pg_catalog.to_tsvector(
            'english',
            coalesce(d.title, '') || ' ' || coalesce(d.document_type, '') || ' ' ||
            coalesce(d.summary, '') || ' ' || coalesce(d.body, '')
          ) @@ (select ts from q)

  )
  select source_id, kind, title, ref, snippet
  from scored
  where scope_rank <> 1 or not exists (select 1 from scored specific where specific.scope_rank > 1)
  order by scope_rank desc, score desc, ord asc
  limit (select lim from q);
$$;

create or replace function public.search_member_kb_hybrid(
  p_query text,
  p_embedding extensions.vector(1024),
  p_limit integer default 4
)
returns table (source_id text, kind text, title text, ref text, snippet text)
language sql
stable
security invoker
set search_path = ''
as $$
  with lim as (
    select least(greatest(coalesce(p_limit, 4), 1), 6) as n
  ),
  -- The lexical search exactly as Compass runs it today, with its own order
  -- carried as the rank (rights lessons and chapter documents included).
  lexical as (
    select s.source_id, s.kind, s.title, s.ref, s.snippet, s.rank::integer as rank,
      case when s.source_id like 'doc:%' then private.compass_scope_specificity(private.compass_context_organization(),
        private.compass_scope_path_for_chapter(private.current_member_chapter()), 'chapter')
      else coalesce(private.compass_scope_specificity(a.compass_organization_id, a.compass_scope_path, a.compass_scope_level), 0) end as scope_rank
    from public.search_member_kb(p_query, 6)
      with ordinality as s(source_id, kind, title, ref, snippet, rank)
    left join public.member_kb_articles a on s.source_id = 'kb:' || a.slug
  ),
  -- Best chunk per article by cosine distance, under the article gates and
  -- only for chunks cut from the article's current body.
  nearest_chunks as materialized (
    select a.id, a.slug, a.kind, a.title, a.article_ref, e.chunk,
      private.compass_scope_specificity(a.compass_organization_id, a.compass_scope_path, a.compass_scope_level) as scope_rank,
      (e.embedding operator(extensions.<=>) p_embedding) as distance
    from public.member_kb_article_embeddings e
    join public.member_kb_articles a on a.id = e.article_id
    where a.compass_organization_id = (select private.compass_context_organization())
      and e.compass_organization_id = (select private.compass_context_organization())
      and p_embedding is not null and extensions.vector_norm(p_embedding) > 0
      and e.model = 'bge-m3'
      and e.digest = 'sha256:7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab'
      and private.compass_article_scope_current(a)
      and private.compass_scope_specificity(a.compass_organization_id, a.compass_scope_path, a.compass_scope_level) > 0
      and not a.is_sample
      and a.status = 'published'
      and a.verified_by is not null
      and a.verified_at is not null
      and private.knowledge_article_content_current(a)
      and private.compass_article_classification_current(a)
      and e.compass_organization_id = a.compass_organization_id
      and e.compass_scope_path = a.compass_scope_path
      and e.classification_sha256 = a.compass_classification ->> 'input_sha256'
      and e.body_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(a.body, 'UTF8')), 'hex')
    order by e.embedding operator(extensions.<=>) p_embedding
    limit 64
  ),
  semantic_chunks as (
    select distinct on (id) * from nearest_chunks
    order by id, distance, chunk
  ),
  semantic as (
    select 'kb:' || c.slug as source_id, c.kind, c.title, c.article_ref as ref,
           pg_catalog.left(c.chunk, 320) as snippet,
           (pg_catalog.row_number() over (order by c.scope_rank desc, c.distance, c.slug))::integer as rank, c.scope_rank
    from semantic_chunks c
    order by c.scope_rank desc, c.distance, c.slug
    limit 6
  ),
  candidates as (
    select 1 as origin, m.* from semantic m
    union all
    select 2 as origin, l.* from lexical l
  ),
  -- Reciprocal rank fusion, k = 60. When both lanes return the same source
  -- the semantic chunk is the snippet (it is the passage that matched).
  fused as (
    select c.source_id,
           (pg_catalog.array_agg(c.kind order by c.origin))[1] as kind,
           (pg_catalog.array_agg(c.title order by c.origin))[1] as title,
           (pg_catalog.array_agg(c.ref order by c.origin))[1] as ref,
           (pg_catalog.array_agg(c.snippet order by c.origin))[1] as snippet,
           pg_catalog.sum(1.0 / (60 + c.rank)) as score,
           pg_catalog.min(c.rank) as best_rank,
           pg_catalog.max(c.scope_rank) as scope_rank
    from candidates c
    group by c.source_id
  )
  select f.source_id, f.kind, f.title, f.ref, f.snippet
  from fused f
  where f.scope_rank <> 1 or not exists (select 1 from fused specific where specific.scope_rank > 1)
  order by f.scope_rank desc, f.score desc, f.best_rank asc, f.source_id
  limit (select n from lim)
$$;

create or replace function private.compass_classified_source(p_source jsonb)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare a public.member_kb_articles%rowtype; title text; ref text; snippet text; receipt jsonb;
begin
  if p_source ->> 'source_id' not like 'kb:%' then return p_source; end if;
  select source.* into a from public.member_kb_articles source
    where 'kb:' || source.slug = p_source ->> 'source_id'
      and private.compass_article_scope_current(source)
      and private.compass_scope_specificity(source.compass_organization_id, source.compass_scope_path, source.compass_scope_level) > 0
      and not source.is_sample and source.status = 'published'
      and source.verified_by is not null and source.verified_at is not null
      and private.knowledge_article_content_current(source)
      and private.compass_article_classification_current(source);
  if not found then return null; end if;
  title := pg_catalog.left(pg_catalog.regexp_replace(a.title, '[[:space:]]+', ' ', 'g'), 160);
  ref := pg_catalog.left(pg_catalog.regexp_replace(a.article_ref, '[[:space:]]+', ' ', 'g'), 120);
  snippet := pg_catalog.left(a.compass_classification ->> 'text', 400);
  if pg_catalog.strpos(a.compass_classification ->> 'text', p_source ->> 'snippet') > 0 then
    snippet := pg_catalog.left(p_source ->> 'snippet', 400);
  end if;
  receipt := pg_catalog.jsonb_build_object('version', 'compass-document-v1', 'status', 'ready', 'rule', a.compass_corpus_rule,
    'filing', a.compass_filing, 'payload_sha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      title || pg_catalog.chr(31) || ref || pg_catalog.chr(31) || snippet, 'UTF8')), 'hex'));
  return p_source || pg_catalog.jsonb_build_object('title', title, 'ref', ref, 'snippet', snippet, 'document_classification', receipt,
    'scope_level', a.compass_scope_level, 'organization_id', a.compass_organization_id);
end;
$$;

create or replace function public.get_compass_ai_context(p_kind text, p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  org uuid := private.compass_context_organization();
  data jsonb; campaign jsonb; official jsonb; address jsonb; bill jsonb;
begin
  if p_kind = 'portal' then
    data := public.get_member_guide_context();
  elsif p_kind = 'lexical' then
    select coalesce(pg_catalog.jsonb_agg(projected.source order by r.ordinal), '[]'::jsonb) into data
    from public.search_member_kb(p_args ->> 'p_query', 4) with ordinality r(source_id, kind, title, ref, snippet, ordinal)
    cross join lateral (select private.compass_classified_source(pg_catalog.to_jsonb(r) - 'ordinal') as source) projected
    where projected.source is not null;
  elsif p_kind = 'hybrid' then
    select coalesce(pg_catalog.jsonb_agg(projected.source order by r.ordinal), '[]'::jsonb) into data
    from public.search_member_kb_hybrid(p_args ->> 'p_query', (p_args ->> 'p_embedding')::extensions.vector, 4) with ordinality r(source_id, kind, title, ref, snippet, ordinal)
    cross join lateral (select private.compass_classified_source(pg_catalog.to_jsonb(r) - 'ordinal') as source) projected
    where projected.source is not null;
  elsif p_kind = 'briefing' then
    data := public.get_message_briefing_context(p_args ->> 'p_source_kind', (p_args ->> 'p_target_id')::uuid);
  elsif p_kind = 'civic' then
    select pg_catalog.jsonb_build_object('id', c.id, 'topic', c.topic, 'summary', c.summary,
      'talking_points', c.talking_points, 'union_position', c.union_position, 'bill_key', c.bill_key,
      'target_offices', c.target_offices) into campaign
    from public.civic_campaigns c where c.id = (p_args ->> 'campaignId')::uuid and c.status = 'active';
    select pg_catalog.jsonb_build_object('full_name', o.full_name, 'office', o.office) into official
    from public.civic_member_officials_keyed o
    where o.user_id = (select auth.uid()) and o.official_key = p_args ->> 'officialKey' limit 1;
    select pg_catalog.jsonb_build_object('city', a.city, 'state', a.state) into address
    from public.civic_member_addresses a limit 1;
    select pg_catalog.jsonb_build_object('identifier', b.identifier, 'title', b.title) into bill
    from public.civic_bills b where b.bill_key = campaign ->> 'bill_key' limit 1;
    data := pg_catalog.jsonb_build_object('campaign', campaign, 'official', official,
      'address', coalesce(address, '{}'::jsonb), 'bill', bill);
  else raise exception 'context kind invalid' using errcode = '22023';
  end if;
  if p_kind in ('lexical', 'hybrid') then
    return pg_catalog.jsonb_build_object('organization_id', org, 'data', data,
      'scope', private.compass_retrieval_scope_summary(p_args ->> 'p_query', data));
  end if;
  return pg_catalog.jsonb_build_object('organization_id', org, 'data', data);
end;
$$;

-- Reviewed metadata triggers add no new account ownership ledger. Existing
-- membership erasure/graph guards still own the member's unit assignment.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where (kind = 'trigger' and (
    (schema_name = 'private' and table_name = 'compass_chapter_scope_bindings' and object_name in ('compass_scope_binding_guard', 'a00_case_graph_lock', 'z99_case_graph_keys'))
    or (schema_name = 'public' and table_name = 'member_kb_articles' and object_name = 'compass_article_scope_binding')
    or (schema_name = 'public' and table_name = 'member_kb_article_embeddings' and object_name = 'compass_embedding_scope_binding')
    or (schema_name = 'public' and table_name = 'member_chapter_memberships' and object_name = 'compass_member_unit_scope_binding')
  )) or (kind = 'function' and schema_name = 'private' and pg_catalog.split_part(object_name, '(', 1) in (
    'compass_scope_binding_guard', 'compass_national_scope_key', 'compass_scope_path_for_chapter',
    'bind_compass_article_scope', 'bind_compass_embedding_scope', 'bind_compass_member_unit_scope'
  ));

notify pgrst, 'reload schema';
commit;
