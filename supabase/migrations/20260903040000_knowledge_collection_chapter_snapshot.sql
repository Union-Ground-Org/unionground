-- Keep the collection workspace on the same explicitly selected chapter as
-- the canonical staff knowledge corpus, and make the CBA review picker a
-- single statement-consistent read. The old collection RPC defaults remain
-- source-compatible through trailing defaults; the mutable keyset review RPC
-- is removed so no authenticated caller can resume an obsolete walk.

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- The native staff scope already established the safe organization-only
-- fallback: a selected chapter stays strongest, while a chapterless account
-- resolves only when exactly one active organization membership exists. Reuse
-- that non-raising resolver in the shared membership/hat predicates so the web
-- knowledge workspace observes the same tenant boundary.
create or replace function private.is_organization_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when (select auth.uid()) is null or p_organization_id is null then false
    when not (select private.mfa_satisfied()) then false
    when p_organization_id is distinct from (select private.current_mobile_staff_organization()) then false
    else exists (
      select 1
      from public.organization_memberships membership
      where membership.organization_id = p_organization_id
        and membership.user_id = (select auth.uid())
        and membership.status = 'active'
    )
  end;
$function$;

create or replace function private.has_organization_role(
  p_organization_id uuid,
  p_roles text[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when (select auth.uid()) is null or p_organization_id is null then false
    when not (select private.mfa_satisfied()) then false
    when p_organization_id is distinct from (select private.current_mobile_staff_organization()) then false
    when not exists (
      select 1
      from public.organization_memberships membership
      where membership.organization_id = p_organization_id
        and membership.user_id = (select auth.uid())
        and membership.status = 'active'
    ) then false
    when not exists (
      select 1
      from public.organization_role_grants role_grant
      where role_grant.organization_id = p_organization_id
        and role_grant.user_id = (select auth.uid())
        and role_grant.role = any(p_roles)
    ) then false
    when not (select private.staff_mfa_required(p_organization_id)) then true
    else (select private.has_second_factor((select auth.uid())))
  end;
$function$;

revoke all on function private.is_organization_member(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.has_organization_role(uuid, text[])
  from public, anon, authenticated, service_role;
grant execute on function private.is_organization_member(uuid) to authenticated;
grant execute on function private.has_organization_role(uuid, text[]) to authenticated;

create or replace function private.mi1_w2_selected_organization()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  selected_chapter text := private.current_member_chapter();
  org uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if selected_chapter is not null then
    org := private.current_member_organization();
  else
    select case when pg_catalog.count(distinct membership.organization_id) = 1
      then pg_catalog.min(membership.organization_id::text)::uuid
      else null
    end into org
    from public.organization_memberships membership
    join public.organizations organization
      on organization.id = membership.organization_id
     and organization.status = 'active'
    where membership.user_id = caller
      and membership.status = 'active';
  end if;
  if org is null then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  return org;
end;
$function$;

revoke all on function private.mi1_w2_selected_organization()
  from public, anon, authenticated, service_role;

create or replace function private.mi1_w2_write_audit(
  p_organization_id uuid,
  p_event_type text,
  p_metadata jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_organization_id is distinct from private.mi1_w2_selected_organization() then
    raise exception 'audit organization is derived from the session' using errcode = '42501';
  end if;
  insert into public.organization_audit_events (
    organization_id, event_type, actor_user_id, idempotency_key, metadata
  ) values (
    p_organization_id,
    p_event_type,
    (select auth.uid()),
    extensions.gen_random_uuid(),
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
$function$;

revoke all on function private.mi1_w2_write_audit(uuid, text, jsonb)
  from public, anon, authenticated, service_role;

-- The storage policies are the second half of register-then-upload. Their
-- prior predicates rejected every chapterless staff account before consulting
-- the unambiguous organization resolver, even though the registration RPC had
-- already authorized and created the exact object path. Keep the bucket-first
-- fast refusal, but bind insert/read/delete to the same non-raising resolver as
-- the surrounding staff authorization helpers. Ambiguous organization
-- membership therefore remains false rather than becoming a wildcard.
create or replace function private.can_insert_organization_knowledge_object(
  p_bucket_id text,
  p_name text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when p_bucket_id is distinct from 'organization-knowledge' then false
    when not private.mfa_satisfied() then false
    when private.current_mobile_staff_organization() is null then false
    else exists (
      select 1
      from public.organization_knowledge_files file
      where file.storage_path = p_name
        and file.created_by = (select auth.uid())
        and file.organization_id = private.current_mobile_staff_organization()
        and file.review_status = 'pending_scan'
    )
  end
$function$;

create or replace function private.can_read_organization_knowledge_object(
  p_bucket_id text,
  p_name text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when p_bucket_id is distinct from 'organization-knowledge' then false
    when not private.mfa_satisfied() then false
    when private.current_mobile_staff_organization() is null then false
    else exists (
      select 1
      from public.organization_knowledge_files file
      where file.storage_path = p_name
        and file.organization_id = private.current_mobile_staff_organization()
        and (
          private.has_organization_role(
            file.organization_id,
            array['steward', 'coordinator', 'advisor', 'admin', 'vp']
          )
          or (
            private.is_organization_member(file.organization_id)
            and file.published_to_catalog
            and file.review_status = 'approved'
            and file.scan_status = 'clean'
          )
        )
    )
  end
$function$;

create or replace function private.can_delete_organization_knowledge_object(
  p_bucket_id text,
  p_name text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when p_bucket_id is distinct from 'organization-knowledge' then false
    when not private.mfa_satisfied() then false
    when private.current_mobile_staff_organization() is null then false
    else exists (
      select 1
      from public.organization_knowledge_files file
      where file.storage_path = p_name
        and file.created_by = (select auth.uid())
        and file.organization_id = private.current_mobile_staff_organization()
        and file.review_status = 'pending_scan'
        and file.scan_status = 'pending'
    )
  end
$function$;

revoke all on function private.can_insert_organization_knowledge_object(text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.can_read_organization_knowledge_object(text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.can_delete_organization_knowledge_object(text, text)
  from public, anon, authenticated, service_role;
grant execute on function private.can_insert_organization_knowledge_object(text, text)
  to authenticated;
grant execute on function private.can_read_organization_knowledge_object(text, text)
  to authenticated;
grant execute on function private.can_delete_organization_knowledge_object(text, text)
  to authenticated;

create function private.mi1_knowledge_context_organization(p_chapter_id text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  requested_chapter text := nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), '');
  org uuid := private.mi1_w2_selected_organization();
begin
  if requested_chapter is not null
     and not private.mi1_w2_same_org_chapter(org, requested_chapter) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return org;
end;
$function$;

revoke all on function private.mi1_knowledge_context_organization(text)
  from public, anon, authenticated, service_role;

-- The preceding review repair introduced the chapter-aware signatures. Drop
-- them before replacing their organization resolver and chapterless behavior;
-- the legacy signatures remain explicit absences in either migration order.
drop function if exists public.delete_knowledge_collection(uuid, text);
drop function if exists public.set_knowledge_collection_item(uuid, text, uuid, boolean, integer, text);
drop function if exists public.save_knowledge_collection(uuid, text, text, text, text, text);
drop function if exists public.list_knowledge_collections(text);
drop function if exists public.list_knowledge_review_articles_snapshot(text);
drop function if exists public.delete_knowledge_collection(uuid);
drop function if exists public.set_knowledge_collection_item(uuid, text, uuid, boolean, integer);
drop function if exists public.save_knowledge_collection(uuid, text, text, text, text);
drop function if exists public.list_knowledge_collections();

create function public.list_knowledge_collections(
  p_chapter_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
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
            and (staff or (
              file.published_to_catalog
              and file.review_status = 'approved'
              and file.scan_status = 'clean'
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

create function public.save_knowledge_collection(
  p_collection_id uuid,
  p_title text,
  p_description text,
  p_visibility text,
  p_scope text,
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
  clean_title text := pg_catalog.btrim(coalesce(p_title, ''));
  clean_description text := pg_catalog.btrim(coalesce(p_description, ''));
  target_chapter text;
  saved public.knowledge_collections%rowtype;
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
  if p_visibility not in ('organization', 'staff')
     or p_scope not in ('chapter', 'organization')
     or pg_catalog.char_length(clean_title) not between 1 and 120
     or pg_catalog.char_length(clean_description) > 1000 then
    raise exception 'invalid collection' using errcode = '22023';
  end if;
  if p_scope = 'organization'
     and not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  target_chapter := case when p_scope = 'chapter' then chapter else null end;
  if p_scope = 'chapter'
     and (target_chapter is null or not private.mi1_w2_same_org_chapter(org, target_chapter)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_collection_id is null then
    insert into public.knowledge_collections (
      organization_id, chapter_id, title, description, visibility, created_by, updated_by
    ) values (
      org, target_chapter, clean_title, clean_description, p_visibility, actor, actor
    ) returning * into saved;
  else
    select * into saved
    from public.knowledge_collections collection
    where collection.id = p_collection_id
      and collection.organization_id = org
    for update;
    if not found then
      raise exception 'not found' using errcode = 'P0002';
    end if;
    if saved.chapter_id is not null
       and saved.chapter_id is distinct from chapter then
      raise exception 'not found' using errcode = 'P0002';
    end if;
    if saved.chapter_id is null
       and not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
      raise exception 'not authorized' using errcode = '42501';
    end if;
    update public.knowledge_collections
       set title = clean_title,
           description = clean_description,
           visibility = p_visibility,
           chapter_id = target_chapter,
           updated_by = actor,
           updated_at = pg_catalog.now()
     where id = p_collection_id
       and organization_id = org
     returning * into saved;
    if not found then
      raise exception 'not found' using errcode = 'P0002';
    end if;
  end if;

  perform private.mi1_w2_write_audit(org, 'knowledge_collection_changed', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'chapterId', saved.chapter_id,
    'collectionId', saved.id,
    'visibility', saved.visibility,
    'scope', case when saved.chapter_id is null then 'organization' else 'chapter' end
  ));
  return public.list_knowledge_collections(chapter);
end;
$function$;

create function public.set_knowledge_collection_item(
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
  if p_item_kind = 'kb_article' and not exists (
    select 1
    from public.member_kb_articles article
    where article.id = p_item_id
      and article.chapter_id = chapter
      and not article.is_sample
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

create function public.delete_knowledge_collection(
  p_collection_id uuid,
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
  removed public.knowledge_collections%rowtype;
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

  select * into removed
  from public.knowledge_collections collection
  where collection.id = p_collection_id
    and collection.organization_id = org
  for update;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if removed.chapter_id is not null
     and removed.chapter_id is distinct from chapter then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if removed.chapter_id is null
     and not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  delete from public.knowledge_collections collection
  where collection.id = removed.id;
  perform private.mi1_w2_write_audit(org, 'knowledge_collection_changed', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'chapterId', removed.chapter_id,
    'collectionId', removed.id,
    'visibility', removed.visibility,
    'scope', case when removed.chapter_id is null then 'organization' else 'chapter' end,
    'action', 'deleted'
  ));
  return public.list_knowledge_collections(chapter);
end;
$function$;

revoke all on function public.list_knowledge_collections(text)
  from public, anon, authenticated, service_role;
revoke all on function public.save_knowledge_collection(uuid, text, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.set_knowledge_collection_item(uuid, text, uuid, boolean, integer, text)
  from public, anon, authenticated, service_role;
revoke all on function public.delete_knowledge_collection(uuid, text)
  from public, anon, authenticated, service_role;

grant execute on function public.list_knowledge_collections(text) to authenticated;
grant execute on function public.save_knowledge_collection(uuid, text, text, text, text, text) to authenticated;
grant execute on function public.set_knowledge_collection_item(uuid, text, uuid, boolean, integer, text) to authenticated;
grant execute on function public.delete_knowledge_collection(uuid, text) to authenticated;

comment on function public.list_knowledge_collections(text) is
  'Lists organization collections plus one current or explicitly selected same-organization chapter for an MFA-bound caller.';
comment on function public.save_knowledge_collection(uuid, text, text, text, text, text) is
  'Creates or updates a collection in the current or explicitly selected same-organization chapter; organization scope remains advisor/admin/VP only.';
comment on function public.set_knowledge_collection_item(uuid, text, uuid, boolean, integer, text) is
  'Adds or removes one collection placement in the current or explicitly selected same-organization chapter.';
comment on function public.delete_knowledge_collection(uuid, text) is
  'Deletes one collection in the current or explicitly selected same-organization chapter; organization scope remains advisor/admin/VP only.';

create function public.list_knowledge_review_articles_snapshot(
  p_chapter_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  target_chapter text := nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), '');
  org uuid := private.mi1_knowledge_context_organization(target_chapter);
begin
  if not private.mfa_satisfied()
     or not private.mi1_knowledge_collection_staff(org)
     or target_chapter is null
     or not private.mi1_w2_same_org_chapter(org, target_chapter) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', article.id,
      'chapterId', article.chapter_id,
      'title', article.title,
      'articleRef', article.article_ref,
      'status', article.status,
      'version', article.version,
      'orderIndex', article.order_index
    ) order by article.order_index, article.id)
    from public.member_kb_articles article
    where article.chapter_id = target_chapter
      and not article.is_sample
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_knowledge_review_articles_snapshot(text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_knowledge_review_articles_snapshot(text)
  to authenticated;

comment on function public.list_knowledge_review_articles_snapshot(text) is
  'Returns every reviewable article for one explicitly selected same-organization chapter from one statement snapshot, so CBA reconciliation cannot move a cursor between pages.';

drop function if exists public.list_knowledge_review_articles_page(text, integer, uuid);
