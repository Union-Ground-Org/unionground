begin;

-- SEC-UG-CLEANROOM-UPLOAD-SECURITY-20260904 — slice 4, fourth repair.
--
-- 20260906024000 bound the WRITE side of the storage-derived knowledge
-- lifecycle (both service-role completion RPCs, under the owning Storage row's
-- lock) and four of its read/publication surfaces:
-- `list_knowledge_review_articles_snapshot`, `list_chapter_kb_revisions`,
-- `restore_chapter_kb_revision` and `search_member_kb`. An independent
-- verification round drove one real contract file through
-- prepare -> inspect clean -> complete -> replace_cba_knowledge_drafts ->
-- restore(publish) on a live disposable database, then quarantined it and then
-- deleted the object, and found that the member-facing half of the same
-- lifecycle was still open:
--
--   * `public.list_accessible_knowledge_articles_snapshot` — the Library /
--     Search read path both web hooks use — returned the imported clause's full
--     `body` to an ordinary chapter member (`p_published_only = true` requires
--     no staff role) with the source blocked, and again after the object was
--     deleted and the ledger row tombstoned to 'deleted'. Its gated twin, the
--     review snapshot, returns metadata only; this one returns the text.
--   * `public.member_kb_articles` itself carries a direct `select` grant to
--     `authenticated` and its two read policies had no provenance conjunct, so
--     the SQL gate could be walked around entirely by the ordinary PostgREST
--     query both clients already issue (`src/lib/memberApi.js` on web boot,
--     `apps/mobile/src/services/livedIn.ts` on native). Gating only the
--     security-definer readers left the table open.
--   * `public.save_chapter_kb_article` would set `status = 'published'`,
--     `verified_by` and `verified_at` on the very article that
--     `restore_chapter_kb_revision` refuses, so the two publication routes to
--     one row disagreed.
--   * `public.list_knowledge_collections` and
--     `public.set_knowledge_collection_item` projected and placed the same rows'
--     metadata with no provenance check — the same class of surface as the
--     review snapshot, which was gated for exactly this reason.
--
-- This migration closes all four so that "indexed, reviewable, publishable and
-- retrievable" genuinely stops outliving the verdict that justified it, on the
-- member path as well as the staff path.
--
-- Invariants are unchanged. `private.private_upload_is_current` remains the one
-- expression consulted (invariant 7); `organization_knowledge_files.scan_status`
-- is still not read; no caller supplies a path, bucket, digest or verdict
-- (invariant 1); every gate is conditioned through
-- `knowledge_source_verdict_current`, which answers true for a null
-- `knowledge_source_id` and for any source that is not `organization_storage`,
-- so authored articles, rights lessons, chapter documents, `external_url` rows,
-- inline text sources and Drive bytes keep their semantics exactly (invariant 6).

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- --------------------------------------------------------------------------
-- 0. Both provenance predicates answer a strict boolean.
--
-- `private.private_upload_is_current` can evaluate to NULL rather than false
-- for a session that carries no `request.jwt.claims` at all, because
-- `((select auth.uid()) is not null or (select auth.role()) = 'service_role')`
-- degrades to `false or NULL`. Both wrappers passed that straight through, and
-- the plpgsql guards are written `if not <predicate> then raise …`, which does
-- NOT fire on NULL — a fail-open shape. The verifier confirmed it is
-- unreachable through every granted entry point at this head (the completion
-- RPCs demand `service_role`, the staff RPCs demand `mfa_satisfied()`,
-- `search_member_kb` runs as the member, and the private helpers are granted
-- only to `authenticated` and `service_role`). This migration adds gates in
-- exactly that shape, so the shape is removed rather than re-audited: both
-- wrappers now coalesce, and a NULL from the ledger predicate is a refusal.
-- --------------------------------------------------------------------------
create or replace function private.knowledge_source_verdict_current(p_source_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  file public.organization_knowledge_files%rowtype;
begin
  -- Authored content has no Storage provenance to check.
  if p_source_id is null then return true; end if;
  select f.* into file
  from public.organization_knowledge_sources s
  join public.organization_knowledge_files f on f.id = s.file_id
  where s.id = p_source_id;
  -- A provenance that cannot be resolved is not a pass.
  if not found then return false; end if;
  -- external_url rows, inline text sources and Drive bytes are not in this
  -- ledger's scope and keep the semantics they had before this record.
  if file.storage_kind is distinct from 'organization_storage' then return true; end if;
  if file.storage_path is null then return false; end if;
  -- coalesce, not a bare call: an unknown answer is a refusal, so a guard
  -- written `if not <predicate>` cannot fail open on a caller-context accident.
  return coalesce(private.private_upload_is_current('organization-knowledge', file.storage_path), false);
end;
$function$;

-- `create or replace` preserves the ACL, but every grant this record touches is
-- re-stated so the surface is readable in one file rather than three.
revoke all on function private.knowledge_source_verdict_current(uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.knowledge_source_verdict_current(uuid)
  to authenticated, service_role;

comment on function private.knowledge_source_verdict_current(uuid) is
  'True when a knowledge source has no Storage provenance, is not organization_storage, or its owning object holds a current ledger verdict; false whenever the provenance cannot be resolved or the ledger predicate is unknown.';

create or replace function private.knowledge_source_object_verdict_locked(
  p_organization_id uuid, p_source_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  file public.organization_knowledge_files%rowtype;
  locked_object_id uuid;
begin
  if p_organization_id is null or p_source_id is null then return false; end if;
  select f.* into file
  from public.organization_knowledge_sources s
  join public.organization_knowledge_files f
    on f.id = s.file_id and f.organization_id = p_organization_id
  where s.id = p_source_id and s.organization_id = p_organization_id;
  if not found then return false; end if;
  if file.storage_kind is distinct from 'organization_storage' then return true; end if;
  if file.storage_path is null then return false; end if;
  -- The lock is the point. `private_upload_is_current` joins storage.objects on
  -- id and version, so holding this row makes the predicate's answer stable for
  -- the rest of the transaction that is about to write derived rows.
  select o.id into locked_object_id
  from storage.objects o
  where o.bucket_id = 'organization-knowledge' and o.name = file.storage_path
  for update;
  if locked_object_id is null then return false; end if;
  return coalesce(private.private_upload_is_current('organization-knowledge', file.storage_path), false);
end;
$function$;

revoke all on function private.knowledge_source_object_verdict_locked(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.knowledge_source_object_verdict_locked(uuid, uuid)
  to service_role;

comment on function private.knowledge_source_object_verdict_locked(uuid, uuid) is
  'Service-only write-side verdict recheck: derives the owning organization-knowledge object from a source id, locks its storage.objects row, then evaluates private.private_upload_is_current; an unresolvable source or an unknown answer is a refusal.';

-- --------------------------------------------------------------------------
-- 1. The member-facing article corpus.
--
-- This is the surface that actually carries the imported clause TEXT to a
-- browser. `p_published_only = true` is the Member/Library read and requires no
-- staff role at all, so a quarantined clause was reaching every member of the
-- chapter. The conjunct sits beside `not article.is_sample` on the one article
-- predicate, so both the member branch and the staff branch are covered by a
-- single clause and an authored article (null provenance) is untouched.
-- --------------------------------------------------------------------------
create or replace function public.list_accessible_knowledge_articles_snapshot(
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
      and private.knowledge_source_verdict_current(article.knowledge_source_id)
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
  'Returns one statement-consistent chapter corpus. Member reads stay on the current chapter and verified publication boundary; staff may explicitly select only a chapter in their active organization; an article whose originating Storage source no longer holds a current ledger verdict is excluded from both.';

-- --------------------------------------------------------------------------
-- 2. The table itself.
--
-- `public.member_kb_articles` carries a direct `select` grant to
-- `authenticated`, and both clients read `body` straight through PostgREST.
-- Gating only the definer readers above would leave the whole gate walkable by
-- the ordinary query the apps already issue, so the same conjunct goes on both
-- read policies. `knowledge_source_verdict_current` is already executable by
-- `authenticated`, and it answers true for a null `knowledge_source_id`, so
-- authored chapter knowledge is unaffected. No write path is touched: the table
-- grants `authenticated` nothing but `select`, and every writer is a
-- security-definer RPC that does not run under RLS.
-- --------------------------------------------------------------------------
drop policy if exists member_kb_articles_member_read on public.member_kb_articles;
create policy member_kb_articles_member_read
  on public.member_kb_articles for select to authenticated
  using (
    chapter_id = private.current_member_chapter()
    and not is_sample
    and status = 'published'
    and verified_by is not null
    and verified_at is not null
    and private.knowledge_source_verdict_current(knowledge_source_id)
  );

drop policy if exists member_kb_articles_staff_read on public.member_kb_articles;
create policy member_kb_articles_staff_read
  on public.member_kb_articles for select to authenticated
  using (
    chapter_id = private.current_member_chapter()
    and not is_sample
    and public.member_has_role(array['steward','coordinator','advisor','admin','vp'])
    and private.knowledge_source_verdict_current(knowledge_source_id)
  );

-- --------------------------------------------------------------------------
-- 3. The second publication route.
--
-- `restore_chapter_kb_revision` refuses to publish a lapsed article;
-- `save_chapter_kb_article` updated the same row and set status='published',
-- verified_by and verified_at with no verdict check at all. One row, two
-- publication routes, one answer. The gate goes on the UPDATE branch only: a
-- new article (`p_article_id is null`) has no `knowledge_source_id` and cannot
-- be Storage-derived.
-- --------------------------------------------------------------------------
create or replace function public.save_chapter_kb_article(
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

    -- The second publication route to a Storage-derived row. Editing or
    -- publishing language that came out of a file whose verdict has lapsed is
    -- refused here for exactly the reason restore_chapter_kb_revision refuses
    -- it, with the same SQLSTATE and the same message. Authored articles carry
    -- a null knowledge_source_id and stay editable.
    if not private.knowledge_source_verdict_current(saved.knowledge_source_id) then
      raise exception 'file inspection required' using errcode = '42501';
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

comment on function public.save_chapter_kb_article(
  uuid, text, text, text, text, text[], text, boolean, text
) is
  'MFA-aware staff-only create/edit/publish path accepts only the current chapter or an explicitly selected same-organization chapter; every successful save appends an immutable revision; editing or publishing an article whose originating Storage source has lost its current ledger verdict is refused.';

-- --------------------------------------------------------------------------
-- 4. Collection projection and placement.
--
-- Metadata only — no body — but the same class of surface as the review
-- snapshot, which was gated for exactly this reason. The projection drops a
-- lapsed article, and placement refuses to ADD one. Removal deliberately stays
-- open: a placement row for an article that has just lost its verdict must
-- still be removable, or the lapse would strand it in the collection forever.
-- --------------------------------------------------------------------------
create or replace function public.list_knowledge_collections(p_chapter_id text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  requested_chapter text := nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), '');
  org uuid := private.mi1_knowledge_context_organization(requested_chapter);
  home_chapter text := private.current_member_chapter();
  chapter text := coalesce(requested_chapter, home_chapter);
  staff boolean := private.mi1_knowledge_collection_staff(org);
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if requested_chapter is not null
     and (not staff or not private.mi1_w2_same_org_chapter(org, requested_chapter)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if requested_chapter is null
     and chapter is not null
     and not private.mi1_w2_same_org_chapter(org, chapter) then
    chapter := null;
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', collection.id,
      'title', collection.title,
      'description', collection.description,
      'visibility', collection.visibility,
      'chapterId', collection.chapter_id,
      'sortOrder', collection.sort_order,
      'items', coalesce((
        select pg_catalog.jsonb_agg(item.value order by item.sort_order, item.id)
        from (
          select placement.id, placement.sort_order, pg_catalog.jsonb_build_object(
            'id', placement.id,
            'kind', 'kb_article',
            'itemId', article.id,
            'title', article.title,
            'summary', article.article_ref,
            'status', article.status,
            'version', article.version
          ) as value
          from public.knowledge_collection_items placement
          join public.member_kb_articles article on article.id = placement.kb_article_id
          where placement.collection_id = collection.id
            and article.chapter_id = chapter
            and not article.is_sample
            and private.knowledge_source_verdict_current(article.knowledge_source_id)
            and (staff or (
              article.status = 'published'
              and article.verified_by is not null
              and article.verified_at is not null
            ))
          union all
          select placement.id, placement.sort_order, pg_catalog.jsonb_build_object(
            'id', placement.id,
            'kind', 'knowledge_file',
            'itemId', file.id,
            'title', file.title,
            'summary', file.summary,
            'status', file.review_status,
            'version', 1
          ) as value
          from public.knowledge_collection_items placement
          join public.organization_knowledge_files file on file.id = placement.knowledge_file_id
          where placement.collection_id = collection.id
            and file.organization_id = org
            and (file.storage_kind <> 'organization_storage'
              or private.private_upload_is_current('organization-knowledge', file.storage_path))
            and (staff or (
              file.published_to_catalog
              and file.review_status = 'approved'
            ))
        ) item
      ), '[]'::jsonb)
    ) order by collection.sort_order, collection.title, collection.id)
    from public.knowledge_collections collection
    where collection.organization_id = org
      and (collection.chapter_id is null or collection.chapter_id = chapter)
      and (collection.visibility = 'organization' or staff)
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_knowledge_collections(text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_knowledge_collections(text)
  to authenticated;

comment on function public.list_knowledge_collections(text) is
  'Tenant-scoped collection projection follows one current or explicitly selected same-organization chapter; members stay on their home chapter and published, verified material; placed articles and files whose originating Storage object has lost its current ledger verdict are omitted.';

create or replace function public.set_knowledge_collection_item(
  p_collection_id uuid,
  p_item_kind text,
  p_item_id uuid,
  p_include boolean,
  p_sort_order integer,
  p_chapter_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  requested_chapter text := nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), '');
  org uuid := private.mi1_knowledge_context_organization(requested_chapter);
  home_chapter text := private.current_member_chapter();
  chapter text := coalesce(requested_chapter, home_chapter);
  actor uuid := (select auth.uid());
  collection public.knowledge_collections%rowtype;
begin
  if not private.mfa_satisfied() or not private.mi1_knowledge_collection_staff(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if requested_chapter is not null
     and not private.mi1_w2_same_org_chapter(org, requested_chapter) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if requested_chapter is null
     and chapter is not null
     and not private.mi1_w2_same_org_chapter(org, chapter) then
    chapter := null;
  end if;
  if p_item_kind not in ('kb_article', 'knowledge_file')
     or p_item_id is null
     or coalesce(p_sort_order, 500) not between 0 and 100000 then
    raise exception 'invalid collection item' using errcode = '22023';
  end if;

  select * into collection
  from public.knowledge_collections source
  where source.id = p_collection_id
    and source.organization_id = org
  for update;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if collection.chapter_id is not null
     and collection.chapter_id is distinct from chapter then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if collection.chapter_id is null
     and not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- Adding a Storage-derived article to a collection needs a live verdict for
  -- the file it came from; removing one never does, so a lapse cannot strand a
  -- placement row that staff can no longer see.
  if p_item_kind = 'kb_article' and not exists (
    select 1
    from public.member_kb_articles article
    where article.id = p_item_id
      and article.chapter_id = chapter
      and not article.is_sample
      and (
        not coalesce(p_include, false)
        or private.knowledge_source_verdict_current(article.knowledge_source_id)
      )
  ) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if p_item_kind = 'knowledge_file' and not exists (
    select 1
    from public.organization_knowledge_files file
    where file.id = p_item_id
      and file.organization_id = org
  ) then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if coalesce(p_include, false) then
    insert into public.knowledge_collection_items (
      organization_id, collection_id, item_kind, kb_article_id,
      knowledge_file_id, sort_order, added_by
    ) values (
      org,
      collection.id,
      p_item_kind,
      case when p_item_kind = 'kb_article' then p_item_id else null end,
      case when p_item_kind = 'knowledge_file' then p_item_id else null end,
      coalesce(p_sort_order, 500),
      actor
    ) on conflict do nothing;
  else
    delete from public.knowledge_collection_items item
    where item.collection_id = collection.id
      and (
        (p_item_kind = 'kb_article' and item.kb_article_id = p_item_id)
        or (p_item_kind = 'knowledge_file' and item.knowledge_file_id = p_item_id)
      );
  end if;

  perform private.mi1_w2_write_audit(org, 'knowledge_collection_item_changed', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'chapterId', chapter,
    'collectionId', collection.id,
    'itemKind', p_item_kind,
    'itemId', p_item_id,
    'included', coalesce(p_include, false)
  ));
  return public.list_knowledge_collections(chapter);
end;
$function$;

revoke all on function public.set_knowledge_collection_item(
  uuid, text, uuid, boolean, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.set_knowledge_collection_item(
  uuid, text, uuid, boolean, integer, text
) to authenticated;

comment on function public.set_knowledge_collection_item(
  uuid, text, uuid, boolean, integer, text
) is
  'Staff-only collection placement writer carries one validated selected chapter and restricts organization-scope placements to advisor, admin, and VP roles; an article whose originating Storage source has lost its current ledger verdict cannot be added, while removal stays reachable.';

notify pgrst, 'reload schema';
commit;
