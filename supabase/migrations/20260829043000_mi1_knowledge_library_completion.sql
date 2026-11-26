-- MI1 CR-071 through CR-075: organization-scoped knowledge library completion.
--
-- This is a clean-room adaptation of the approved pre-cutover collection,
-- revision, file-library, resource, and Drive concepts. It deliberately uses
-- current organization/chapter membership, MFA, RPC-only writes, private
-- credential custody, and the existing organization_knowledge_* foundation.

set local lock_timeout = '5s';

-- Extend the bounded tenant-audit vocabulary before the new RPCs can emit
-- collection and restoration events.
alter table public.organization_audit_events
  drop constraint organization_audit_events_event_type_check,
  drop constraint organization_audit_events_metadata_keys;

alter table public.organization_audit_events
  add constraint organization_audit_events_event_type_check check (event_type in (
    'first_organization_bootstrap',
    'organization_membership_granted', 'organization_membership_revoked',
    'organization_role_granted', 'organization_role_revoked',
    'staff_mfa_policy_changed', 'qa_question_asked', 'qa_official_replied',
    'qa_follow_up_replied', 'qa_answer_accepted', 'qa_answer_unaccepted',
    'qa_vote_toggled', 'qa_edited', 'qa_deleted', 'analytics_snapshot_read',
    'analytics_export_requested', 'pay_scale_grade_upserted',
    'pay_scale_step_upserted', 'integration_provider_changed',
    'integration_webhook_changed', 'integration_api_key_changed',
    'organization_job_acknowledged', 'organization_job_retry_requested',
    'survey_draft_saved', 'survey_published', 'survey_closed',
    'survey_reopened', 'survey_session_saved', 'survey_session_submitted',
    'case_deadline_extension_requested', 'case_deadline_change_reviewed',
    'case_deadline_applied', 'case_checklist_patched', 'case_step_advanced',
    'case_restriction_toggled', 'case_restriction_access_changed',
    'case_alert_acknowledged', 'case_alert_escalated',
    'case_reminder_created', 'case_reminder_disposed',
    'knowledge_file_uploaded', 'knowledge_file_reviewed',
    'knowledge_file_published_to_catalog', 'knowledge_file_downloaded',
    'knowledge_source_retried', 'knowledge_source_chunks_cleared',
    'contract_clause_created', 'contract_clause_updated',
    'contract_clause_retired', 'contract_clause_restored',
    'member_access_recorded',
    'knowledge_collection_changed', 'knowledge_collection_item_changed',
    'knowledge_revision_restored', 'knowledge_ingest_authorized',
    'google_drive_operation_authorized', 'member_handoff_initiated',
    'member_handoff_acknowledged', 'member_handoff_declined',
    'member_handoff_cancelled'
  )),
  add constraint organization_audit_events_metadata_keys check (
    metadata - array[
      'organizationId', 'chapterId', 'slug', 'name', 'role', 'userId',
      'status', 'requireStaffMfa', 'questionId', 'replyId', 'targetKind',
      'voted', 'kind', 'surface', 'exportFormat', 'rowCount', 'suppressedCount',
      'expiresAt', 'grade', 'stepNumber', 'effectiveOn', 'action', 'provider',
      'host', 'events', 'entityType', 'entityId', 'fromStatus', 'toStatus',
      'fromRole', 'toRole', 'eventType', 'domain', 'jobName', 'runId',
      'remediation', 'outcome', 'count', 'fieldsChanged', 'reasonCode',
      'exportType', 'cadence', 'surveyId', 'sessionId', 'privacyMinResponses',
      'caseId', 'fromStep', 'toStep', 'previousDeadline', 'newDeadline',
      'alertId', 'reminderId', 'restricted', 'fileId', 'sourceId', 'category',
      'library', 'reviewStatus', 'indexStatus', 'byteSize', 'handoffId',
      'fromStewardId', 'toStewardId', 'clauseId', 'article',
      'collectionId', 'visibility', 'scope',
      'itemKind', 'itemId', 'included', 'articleId', 'restoredRevisionId',
      'restoredFromVersion', 'newVersion', 'accountEmail'
    ] = '{}'::jsonb
  );

-- ---------------------------------------------------------------------------
-- CR-071: reusable collections and revision restoration
-- ---------------------------------------------------------------------------

create table public.knowledge_collections (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text references public.chapters(id) on update cascade on delete restrict,
  title text not null,
  description text not null default '',
  visibility text not null default 'organization' check (visibility in ('organization', 'staff')),
  sort_order integer not null default 500 check (sort_order between 0 and 100000),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint knowledge_collections_title_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 120
    and title !~ '[[:cntrl:]]'
  ),
  constraint knowledge_collections_description_bounded check (
    pg_catalog.char_length(description) <= 1000
  )
);

create index knowledge_collections_org_scope_idx
  on public.knowledge_collections (organization_id, chapter_id, visibility, sort_order, id);

create table public.knowledge_collection_items (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  collection_id uuid not null references public.knowledge_collections(id) on delete cascade,
  item_kind text not null check (item_kind in ('kb_article', 'knowledge_file')),
  kb_article_id uuid references public.member_kb_articles(id) on delete cascade,
  knowledge_file_id uuid references public.organization_knowledge_files(id) on delete cascade,
  sort_order integer not null default 500 check (sort_order between 0 and 100000),
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint knowledge_collection_items_one_target check (
    pg_catalog.num_nonnulls(kb_article_id, knowledge_file_id) = 1
  ),
  constraint knowledge_collection_items_kind_target check (
    (item_kind = 'kb_article' and kb_article_id is not null)
    or (item_kind = 'knowledge_file' and knowledge_file_id is not null)
  )
);

create index knowledge_collection_items_collection_idx
  on public.knowledge_collection_items (collection_id, sort_order, id);
create unique index knowledge_collection_items_article_unique
  on public.knowledge_collection_items (collection_id, kb_article_id)
  where kb_article_id is not null;
create unique index knowledge_collection_items_file_unique
  on public.knowledge_collection_items (collection_id, knowledge_file_id)
  where knowledge_file_id is not null;

alter table public.knowledge_collections enable row level security;
alter table public.knowledge_collections force row level security;
alter table public.knowledge_collection_items enable row level security;
alter table public.knowledge_collection_items force row level security;

create policy mfa_assurance on public.knowledge_collections
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

create policy mfa_assurance on public.knowledge_collection_items
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on table public.knowledge_collections from public, anon, authenticated, service_role;
revoke all on table public.knowledge_collection_items from public, anon, authenticated, service_role;

create function private.mi1_knowledge_collection_staff(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.mfa_satisfied()
    and private.has_organization_role(
      p_organization_id,
      array['steward', 'coordinator', 'advisor', 'admin', 'vp']
    )
$function$;

create function private.mi1_knowledge_collection_visible(
  p_organization_id uuid,
  p_chapter_id text,
  p_visibility text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.mfa_satisfied()
    and private.is_organization_member(p_organization_id)
    and (p_chapter_id is null or p_chapter_id = private.current_member_chapter())
    and (
      p_visibility = 'organization'
      or private.mi1_knowledge_collection_staff(p_organization_id)
    )
$function$;

revoke all on function private.mi1_knowledge_collection_staff(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.mi1_knowledge_collection_visible(uuid, text, text)
  from public, anon, authenticated, service_role;

create policy knowledge_collections_read
  on public.knowledge_collections for select to authenticated
  using (private.mi1_knowledge_collection_visible(organization_id, chapter_id, visibility));

create policy knowledge_collection_items_read
  on public.knowledge_collection_items for select to authenticated
  using (
    exists (
      select 1 from public.knowledge_collections c
      where c.id = knowledge_collection_items.collection_id
        and c.organization_id = knowledge_collection_items.organization_id
        and private.mi1_knowledge_collection_visible(c.organization_id, c.chapter_id, c.visibility)
    )
  );

create function public.list_knowledge_collections()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  chapter text := private.current_member_chapter();
  staff boolean := private.mi1_knowledge_collection_staff(org);
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id,
      'title', c.title,
      'description', c.description,
      'visibility', c.visibility,
      'chapterId', c.chapter_id,
      'sortOrder', c.sort_order,
      'items', coalesce((
        select pg_catalog.jsonb_agg(item.value order by item.sort_order, item.id)
        from (
          select i.id, i.sort_order, pg_catalog.jsonb_build_object(
            'id', i.id,
            'kind', 'kb_article',
            'itemId', article.id,
            'title', article.title,
            'summary', article.article_ref,
            'status', article.status,
            'version', article.version
          ) as value
          from public.knowledge_collection_items i
          join public.member_kb_articles article on article.id = i.kb_article_id
          where i.collection_id = c.id
            and article.chapter_id = chapter
            and not article.is_sample
            and (staff or (
              article.status = 'published'
              and article.verified_by is not null
              and article.verified_at is not null
            ))
          union all
          select i.id, i.sort_order, pg_catalog.jsonb_build_object(
            'id', i.id,
            'kind', 'knowledge_file',
            'itemId', file.id,
            'title', file.title,
            'summary', file.summary,
            'status', file.review_status,
            'version', 1
          ) as value
          from public.knowledge_collection_items i
          join public.organization_knowledge_files file on file.id = i.knowledge_file_id
          where i.collection_id = c.id
            and file.organization_id = org
            and (staff or (
              file.published_to_catalog
              and file.review_status = 'approved'
              and file.scan_status = 'clean'
            ))
        ) item
      ), '[]'::jsonb)
    ) order by c.sort_order, c.title, c.id)
    from public.knowledge_collections c
    where c.organization_id = org
      and (c.chapter_id is null or c.chapter_id = chapter)
      and (c.visibility = 'organization' or staff)
  ), '[]'::jsonb);
end;
$function$;

create function public.save_knowledge_collection(
  p_collection_id uuid,
  p_title text,
  p_description text,
  p_visibility text,
  p_scope text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  chapter text := private.current_member_chapter();
  actor uuid := (select auth.uid());
  clean_title text := pg_catalog.btrim(coalesce(p_title, ''));
  clean_description text := pg_catalog.btrim(coalesce(p_description, ''));
  target_chapter text;
  saved public.knowledge_collections%rowtype;
begin
  if not private.mfa_satisfied() or not private.mi1_knowledge_collection_staff(org) then
    raise exception 'not authorized' using errcode = '42501';
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
    ) values (org, target_chapter, clean_title, clean_description, p_visibility, actor, actor)
    returning * into saved;
  else
    select * into saved from public.knowledge_collections collection
    where collection.id = p_collection_id and collection.organization_id = org
    for update;
    if not found then raise exception 'not found' using errcode = 'P0002'; end if;
    if saved.chapter_id is not null and saved.chapter_id is distinct from chapter then
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
    where id = p_collection_id and organization_id = org
    returning * into saved;
    if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  end if;
  perform private.mi1_w2_write_audit(org, 'knowledge_collection_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'collectionId', saved.id, 'visibility', saved.visibility,
    'scope', case when saved.chapter_id is null then 'organization' else 'chapter' end
  ));
  return public.list_knowledge_collections();
end;
$function$;

create function public.set_knowledge_collection_item(
  p_collection_id uuid,
  p_item_kind text,
  p_item_id uuid,
  p_include boolean,
  p_sort_order integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  chapter text := private.current_member_chapter();
  actor uuid := (select auth.uid());
  collection public.knowledge_collections%rowtype;
begin
  if not private.mfa_satisfied() or not private.mi1_knowledge_collection_staff(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_item_kind not in ('kb_article', 'knowledge_file') or p_item_id is null
     or coalesce(p_sort_order, 500) not between 0 and 100000 then
    raise exception 'invalid collection item' using errcode = '22023';
  end if;
  select * into collection from public.knowledge_collections
  where id = p_collection_id and organization_id = org for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if collection.chapter_id is not null and collection.chapter_id is distinct from chapter then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if collection.chapter_id is null
     and not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_item_kind = 'kb_article' and not exists (
    select 1 from public.member_kb_articles article
    where article.id = p_item_id
      and article.chapter_id = private.current_member_chapter()
      and not article.is_sample
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  if p_item_kind = 'knowledge_file' and not exists (
    select 1 from public.organization_knowledge_files file
    where file.id = p_item_id and file.organization_id = org
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  if coalesce(p_include, false) then
    insert into public.knowledge_collection_items (
      organization_id, collection_id, item_kind, kb_article_id,
      knowledge_file_id, sort_order, added_by
    ) values (
      org, collection.id, p_item_kind,
      case when p_item_kind = 'kb_article' then p_item_id else null end,
      case when p_item_kind = 'knowledge_file' then p_item_id else null end,
      coalesce(p_sort_order, 500), actor
    ) on conflict do nothing;
  else
    delete from public.knowledge_collection_items item
    where item.collection_id = collection.id
      and ((p_item_kind = 'kb_article' and item.kb_article_id = p_item_id)
        or (p_item_kind = 'knowledge_file' and item.knowledge_file_id = p_item_id));
  end if;
  perform private.mi1_w2_write_audit(org, 'knowledge_collection_item_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'collectionId', collection.id, 'itemKind', p_item_kind,
    'itemId', p_item_id, 'included', coalesce(p_include, false)
  ));
  return public.list_knowledge_collections();
end;
$function$;

create function public.delete_knowledge_collection(p_collection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  chapter text := private.current_member_chapter();
  removed public.knowledge_collections%rowtype;
begin
  if not private.mfa_satisfied() or not private.mi1_knowledge_collection_staff(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into removed from public.knowledge_collections collection
  where collection.id = p_collection_id and collection.organization_id = org
  for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if removed.chapter_id is not null and removed.chapter_id is distinct from chapter then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if removed.chapter_id is null
     and not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  delete from public.knowledge_collections collection where collection.id = removed.id;
  perform private.mi1_w2_write_audit(org, 'knowledge_collection_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'collectionId', removed.id, 'visibility', removed.visibility,
    'scope', case when removed.chapter_id is null then 'organization' else 'chapter' end,
    'action', 'deleted'
  ));
  return public.list_knowledge_collections();
end;
$function$;

create function public.list_chapter_kb_revisions(p_article_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  chapter text := private.current_member_chapter();
begin
  if not private.mfa_satisfied() or not private.mi1_knowledge_collection_staff(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.member_kb_articles article
    where article.id = p_article_id and article.chapter_id = chapter and not article.is_sample
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', revision.id, 'version', revision.version, 'status', revision.status,
      'kind', revision.kind, 'title', revision.title, 'articleRef', revision.article_ref,
      'body', revision.body, 'keywords', revision.keywords,
      'changedBy', revision.changed_by, 'changedAt', revision.changed_at
    ) order by revision.version desc)
    from (
      select source.* from public.member_kb_article_revisions source
      where source.article_id = p_article_id and source.chapter_id = chapter
      order by source.version desc limit 50
    ) revision
  ), '[]'::jsonb);
end;
$function$;

create function public.restore_chapter_kb_revision(
  p_article_id uuid,
  p_revision_id bigint,
  p_confirm_verified boolean,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  chapter text := private.current_member_chapter();
  actor uuid := (select auth.uid());
  article public.member_kb_articles%rowtype;
  revision public.member_kb_article_revisions%rowtype;
  restored public.member_kb_articles%rowtype;
  next_status text;
  request_payload jsonb := pg_catalog.jsonb_build_object(
    'articleId', p_article_id, 'revisionId', p_revision_id,
    'confirmVerified', coalesce(p_confirm_verified, false)
  );
  cached jsonb;
  cached_request jsonb;
begin
  if not private.mfa_satisfied()
     or not private.mi1_knowledge_collection_staff(org)
     or p_idempotency_key is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'restore_chapter_kb_revision:' || org::text || ':' || actor::text || ':' || p_idempotency_key::text, 509
  ));
  select receipt.result, receipt.request_payload into cached, cached_request
  from private.mi1_w2_operation_receipts receipt
  where receipt.organization_id = org
    and receipt.operation = 'restore_chapter_kb_revision'
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if cached_request is distinct from request_payload then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    return cached;
  end if;
  select * into article from public.member_kb_articles source
  where source.id = p_article_id and source.chapter_id = chapter and not source.is_sample
  for update;
  select * into revision from public.member_kb_article_revisions source
  where source.id = p_revision_id and source.article_id = p_article_id and source.chapter_id = chapter;
  if article.id is null or revision.id is null then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  next_status := case when revision.status = 'published' and coalesce(p_confirm_verified, false)
    then 'published' else 'draft' end;
  update public.member_kb_articles
  set kind = revision.kind,
      title = revision.title,
      article_ref = revision.article_ref,
      body = revision.body,
      keywords = revision.keywords,
      status = next_status,
      version = article.version + 1,
      updated_by = actor,
      verified_by = case when next_status = 'published' then actor else null end,
      verified_at = case when next_status = 'published' then pg_catalog.now() else null end,
      updated_at = pg_catalog.now()
  where id = article.id returning * into restored;
  insert into public.member_kb_article_revisions (
    article_id, chapter_id, version, status, kind, title, article_ref, body,
    keywords, changed_by, verified_by, verified_at
  ) values (
    restored.id, restored.chapter_id, restored.version, restored.status,
    restored.kind, restored.title, restored.article_ref, restored.body,
    restored.keywords, actor, restored.verified_by, restored.verified_at
  );
  cached := pg_catalog.to_jsonb(restored);
  insert into private.mi1_w2_operation_receipts (
    organization_id, operation, idempotency_key, request_payload, result
  ) values (org, 'restore_chapter_kb_revision', p_idempotency_key, request_payload, cached);
  perform private.mi1_w2_write_audit(org, 'knowledge_revision_restored', pg_catalog.jsonb_build_object(
    'organizationId', org, 'articleId', restored.id, 'restoredRevisionId', revision.id,
    'restoredFromVersion', revision.version, 'newVersion', restored.version,
    'status', restored.status
  ));
  return cached;
end;
$function$;

-- ---------------------------------------------------------------------------
-- CR-073/074: the existing metadata RPCs now reach real protected bytes.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values ('organization-knowledge', 'organization-knowledge', false, 10485760)
on conflict (id) do update
set public = false, file_size_limit = 10485760;

create policy organization_knowledge_objects_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'organization-knowledge'
    and exists (
      select 1 from public.organization_knowledge_files file
      where file.storage_path = name
        and file.created_by = (select auth.uid())
        and file.organization_id = private.mi1_w2_selected_organization()
        and file.review_status = 'pending_scan'
    )
  );

create policy organization_knowledge_objects_read
  on storage.objects for select to authenticated
  using (
    bucket_id = 'organization-knowledge'
    and exists (
      select 1 from public.organization_knowledge_files file
      where file.storage_path = name
        and file.organization_id = private.mi1_w2_selected_organization()
        and (
          private.has_organization_role(file.organization_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
          or (
            private.is_organization_member(file.organization_id)
            and file.published_to_catalog
            and file.review_status = 'approved'
            and file.scan_status = 'clean'
          )
        )
    )
  );

create policy organization_knowledge_objects_delete
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'organization-knowledge'
    and exists (
      select 1 from public.organization_knowledge_files file
      where file.storage_path = name
        and file.created_by = (select auth.uid())
        and file.organization_id = private.mi1_w2_selected_organization()
        and file.review_status = 'pending_scan'
        and file.scan_status = 'pending'
    )
  );

create function public.get_knowledge_file_storage_target(
  p_file_id uuid,
  p_storage_handle uuid,
  p_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  file public.organization_knowledge_files%rowtype;
begin
  if not private.mfa_satisfied() or p_mode not in ('upload', 'steward_download', 'catalog_download') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into file from public.organization_knowledge_files source
  where source.id = p_file_id and source.organization_id = org;
  if not found or file.storage_handle is distinct from p_storage_handle then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if p_mode = 'upload' then
    if file.created_by is distinct from (select auth.uid())
       or file.review_status <> 'pending_scan' then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  elsif p_mode = 'steward_download' then
    if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
      raise exception 'not authorized' using errcode = '42501';
    end if;
    perform private.mi1_w2_download_knowledge_file(file.id, false);
  else
    perform private.mi1_w2_download_knowledge_file(file.id, true);
  end if;
  return pg_catalog.jsonb_build_object(
    'fileId', file.id,
    'bucketId', 'organization-knowledge',
    'objectName', file.storage_path,
    'fileName', file.file_name,
    'mimeType', file.mime_type,
    'storageHandle', file.storage_handle
  );
end;
$function$;

create function public.cancel_steward_library_upload(p_file_id uuid, p_storage_handle uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  delete from public.organization_knowledge_files file
  where file.id = p_file_id
    and file.organization_id = org
    and file.created_by = (select auth.uid())
    and file.storage_handle = p_storage_handle
    and file.review_status = 'pending_scan'
    and file.scan_status = 'pending';
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  return pg_catalog.jsonb_build_object('fileId', p_file_id, 'cancelled', true);
end;
$function$;

-- The earlier metadata foundation registered a source but optimistically
-- called the bytes clean before any parser saw them. Completion now means only
-- "the object upload finished". The server ingestion worker is the sole path
-- that advances scan/index health after validating and extracting the bytes.
create or replace function public.complete_steward_library_upload(
  p_upload_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  file public.organization_knowledge_files%rowtype;
  cached jsonb;
  cached_request jsonb;
  request_payload jsonb := pg_catalog.jsonb_build_object('uploadId', p_upload_id);
  result jsonb;
begin
  if not private.mfa_satisfied()
     or not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'complete_steward_library_upload:' || org::text || ':' || p_idempotency_key::text, 509
  ));
  select receipt.result, receipt.request_payload into cached, cached_request
  from private.mi1_w2_operation_receipts receipt
  where receipt.organization_id = org and receipt.operation = 'complete_steward_library_upload'
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if cached_request is distinct from request_payload then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    return cached;
  end if;
  select * into file from public.organization_knowledge_files source
  where source.id = p_upload_id and source.organization_id = org for update;
  if not found or file.created_by is distinct from (select auth.uid()) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  update public.organization_knowledge_files
  set scan_status = 'pending', review_status = 'pending_scan', index_status = 'pending',
      updated_at = pg_catalog.now()
  where id = file.id and organization_id = org;
  insert into public.organization_knowledge_sources (
    organization_id, file_id, source_kind, label, doc_type, health, last_ingest_at
  ) select org, file.id, 'steward_file', file.title, file.doc_type, 'partial', null
  where not exists (
    select 1 from public.organization_knowledge_sources source
    where source.organization_id = org and source.file_id = file.id
  );
  result := private.mi1_w2_project_knowledge_file(file.id) || pg_catalog.jsonb_build_object(
    'sourceId', (
      select source.id from public.organization_knowledge_sources source
      where source.organization_id = org and source.file_id = file.id
      order by source.created_at, source.id limit 1
    )
  );
  insert into private.mi1_w2_operation_receipts (
    organization_id, operation, idempotency_key, request_payload, result
  ) values (org, 'complete_steward_library_upload', p_idempotency_key, request_payload, result);
  return result;
end;
$function$;

create function public.authorize_knowledge_ingest(p_source_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  actor uuid := (select auth.uid());
  source public.organization_knowledge_sources%rowtype;
  file public.organization_knowledge_files%rowtype;
  recent_count integer;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  select * into source from public.organization_knowledge_sources row
  where row.id = p_source_id and row.organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  select * into file from public.organization_knowledge_files row
  where row.id = source.file_id and row.organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if not private.has_organization_role(org, array['advisor', 'admin', 'vp'])
     and not (
       file.created_by = actor
       and file.scan_status = 'pending' and file.index_status = 'pending'
     ) then raise exception 'not authorized' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'authorize_knowledge_ingest:' || org::text || ':' || actor::text, 509
  ));
  select pg_catalog.count(*) into recent_count
  from public.organization_audit_events event
  where event.organization_id = org
    and event.actor_user_id = actor
    and event.event_type = 'knowledge_ingest_authorized'
    and event.created_at >= pg_catalog.now() - interval '1 hour';
  if recent_count >= 20 then
    return pg_catalog.jsonb_build_object('rateLimited', true);
  end if;
  perform private.mi1_w2_write_audit(org, 'knowledge_ingest_authorized', pg_catalog.jsonb_build_object(
    'organizationId', org, 'fileId', file.id, 'sourceId', source.id, 'action', 'ingest'
  ));
  return pg_catalog.jsonb_build_object(
    'organizationId', org, 'sourceId', source.id, 'fileId', file.id,
    'bucketId', 'organization-knowledge', 'objectName', file.storage_path,
    'fileName', file.file_name, 'mimeType', file.mime_type,
    'byteSize', file.byte_size, 'contentSha256', file.content_sha256,
    'actorUserId', actor, 'rateLimited', false
  );
end;
$function$;

create function public.replace_knowledge_source_chunks(
  p_organization_id uuid,
  p_source_id uuid,
  p_actor_user_id uuid,
  p_chunks jsonb,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  source public.organization_knowledge_sources%rowtype;
  item record;
  item_count integer;
  error_code text := nullif(pg_catalog.btrim(coalesce(p_error_code, '')), '');
begin
  if (select auth.role()) <> 'service_role'
     or p_organization_id is null or p_source_id is null or p_actor_user_id is null
     or pg_catalog.jsonb_typeof(coalesce(p_chunks, '[]'::jsonb)) <> 'array'
     or pg_catalog.jsonb_array_length(coalesce(p_chunks, '[]'::jsonb)) > 500
     or (error_code is not null and error_code !~ '^knowledge-[a-z0-9-]{1,110}$') then
    raise exception 'invalid ingest completion' using errcode = '22023';
  end if;
  select * into source from public.organization_knowledge_sources row
  where row.id = p_source_id and row.organization_id = p_organization_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from public.organization_memberships membership
    join public.organization_role_grants role
      on role.organization_id = membership.organization_id and role.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id = p_actor_user_id and membership.status = 'active'
      and role.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  ) then raise exception 'not authorized' using errcode = '42501'; end if;
  delete from public.organization_knowledge_chunks chunk
  where chunk.source_id = source.id and chunk.organization_id = p_organization_id;
  if error_code is not null then
    update public.organization_knowledge_sources
    set chunk_count = 0, embedded_count = 0, health = 'failed',
        last_error = error_code, last_ingest_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where id = source.id and organization_id = p_organization_id;
    update public.organization_knowledge_files
    set scan_status = 'blocked', index_status = 'failed', updated_at = pg_catalog.now()
    where id = source.file_id and organization_id = p_organization_id;
  else
    item_count := pg_catalog.jsonb_array_length(p_chunks);
    if item_count = 0 then raise exception 'ingest produced no chunks' using errcode = '22023'; end if;
    for item in select value, ordinality from pg_catalog.jsonb_array_elements_text(p_chunks) with ordinality loop
      if pg_catalog.char_length(item.value) not between 1 and 8000 then
        raise exception 'invalid knowledge chunk' using errcode = '22023';
      end if;
      insert into public.organization_knowledge_chunks (
        organization_id, source_id, chunk_index, content
      ) values (p_organization_id, source.id, item.ordinality - 1, item.value);
    end loop;
    update public.organization_knowledge_sources
    set chunk_count = item_count, embedded_count = 0, health = 'unset_embedding',
        last_error = null, last_ingest_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where id = source.id and organization_id = p_organization_id;
    update public.organization_knowledge_files
    set scan_status = 'clean', index_status = 'chunked', updated_at = pg_catalog.now()
    where id = source.file_id and organization_id = p_organization_id;
  end if;
  insert into public.organization_audit_events (
    organization_id, event_type, actor_user_id, idempotency_key, metadata
  ) values (
    p_organization_id, 'knowledge_source_retried', p_actor_user_id,
    extensions.gen_random_uuid(), pg_catalog.jsonb_build_object(
      'organizationId', p_organization_id, 'fileId', source.file_id, 'sourceId', source.id,
      'indexStatus', case when error_code is null then 'chunked' else 'failed' end,
      'action', case when error_code is null then 'ingested' else 'failed' end
    )
  );
  return pg_catalog.jsonb_build_object(
    'id', source.id, 'fileId', source.file_id,
    'chunkCount', case when error_code is null then item_count else 0 end,
    'embeddedCount', 0,
    'health', case when error_code is null then 'unset_embedding' else 'failed' end,
    'lastError', error_code
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- CR-075: organization-owned Google Drive OAuth state and credential custody.
-- ---------------------------------------------------------------------------

alter table public.organization_integrations
  drop constraint organization_integrations_provider_check;
alter table public.organization_integrations
  add constraint organization_integrations_provider_check check (provider in (
    'twilio', 'google_calendar', 'microsoft_calendar', 'constant_contact',
    'cba_ingest', 'google_drive', 'customer_webhooks', 'customer_api', 'scim'
  ));

create table private.google_drive_oauth_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  organization_id uuid not null references public.organizations(id) on update cascade on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  code_verifier text not null check (pg_catalog.char_length(code_verifier) between 43 and 128),
  redirect_uri text not null check (pg_catalog.char_length(redirect_uri) between 12 and 500),
  expires_at timestamptz not null,
  created_at timestamptz not null default pg_catalog.now()
);

revoke all on table private.google_drive_oauth_states from public, anon, authenticated, service_role;

create function public.begin_google_drive_oauth(
  p_state_hash text,
  p_code_verifier text,
  p_redirect_uri text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  actor uuid := (select auth.uid());
begin
  if not private.mfa_satisfied()
     or p_state_hash !~ '^[0-9a-f]{64}$'
     or pg_catalog.char_length(coalesce(p_code_verifier, '')) not between 43 and 128
     or p_redirect_uri !~ '^https://[^[:space:][:cntrl:]]+$'
     or p_expires_at <= pg_catalog.now()
     or p_expires_at > pg_catalog.now() + interval '15 minutes' then
    raise exception 'invalid oauth request' using errcode = '22023';
  end if;
  delete from private.google_drive_oauth_states where expires_at <= pg_catalog.now();
  insert into private.google_drive_oauth_states (
    state_hash, organization_id, user_id, code_verifier, redirect_uri, expires_at
  ) values (p_state_hash, org, actor, p_code_verifier, p_redirect_uri, p_expires_at);
  insert into public.organization_integrations (organization_id, provider, status)
  values (org, 'google_drive', 'requested')
  on conflict (organization_id, provider) do update
    set status = 'requested', last_error_code = null, updated_at = pg_catalog.now();
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', 'google_drive', 'status', 'oauth_started'
  ));
  return pg_catalog.jsonb_build_object('organizationId', org, 'status', 'requested');
end;
$function$;

create function public.get_google_drive_activation()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  integration public.organization_integrations%rowtype;
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into integration from public.organization_integrations
  where organization_id = org and provider = 'google_drive';
  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'provider', 'google_drive',
    'status', coalesce(integration.status, 'unset'),
    'connected', coalesce(integration.status = 'connected' and integration.credential_ref is not null, false),
    'accountEmail', integration.default_settings ->> 'accountEmail',
    'rootFolderId', integration.default_settings ->> 'rootFolderId',
    'lastErrorCode', integration.last_error_code
  );
end;
$function$;

create function public.authorize_google_drive_operation(p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  actor uuid := (select auth.uid());
  integration public.organization_integrations%rowtype;
  recent_count integer;
  hourly_limit integer;
begin
  if not private.mfa_satisfied()
     or p_action not in ('list', 'upload', 'download')
     or not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into integration from public.organization_integrations
  where organization_id = org and provider = 'google_drive'
    and status = 'connected' and credential_ref is not null;
  if not found then raise exception 'google drive is not connected' using errcode = '55000'; end if;
  hourly_limit := case when p_action = 'list' then 240 else 60 end;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'authorize_google_drive_operation:' || org::text || ':' || actor::text || ':' || p_action, 509
  ));
  select pg_catalog.count(*) into recent_count
  from public.organization_audit_events event
  where event.organization_id = org
    and event.actor_user_id = actor
    and event.event_type = 'google_drive_operation_authorized'
    and event.metadata ->> 'action' = p_action
    and event.created_at >= pg_catalog.now() - interval '1 hour';
  if recent_count >= hourly_limit then
    return pg_catalog.jsonb_build_object('rateLimited', true, 'action', p_action);
  end if;
  perform private.mi1_w2_write_audit(org, 'google_drive_operation_authorized', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', 'google_drive', 'action', p_action
  ));
  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'rootFolderId', integration.default_settings ->> 'rootFolderId',
    'action', p_action, 'rateLimited', false
  );
end;
$function$;

create function public.claim_google_drive_oauth_state(p_state text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  state private.google_drive_oauth_states%rowtype;
begin
  if (select auth.role()) <> 'service_role' or p_state is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  delete from private.google_drive_oauth_states source
  where source.state_hash = pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_state, 'UTF8'), 'sha256'), 'hex'
  ) and source.expires_at > pg_catalog.now()
  returning * into state;
  if not found then raise exception 'invalid oauth state' using errcode = '42501'; end if;
  return pg_catalog.jsonb_build_object(
    'organizationId', state.organization_id,
    'userId', state.user_id,
    'codeVerifier', state.code_verifier,
    'redirectUri', state.redirect_uri
  );
end;
$function$;

create function public.complete_google_drive_oauth(
  p_organization_id uuid,
  p_user_id uuid,
  p_refresh_token text,
  p_scopes text,
  p_account_email text,
  p_root_folder_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  secret_id uuid;
  old_ref uuid;
begin
  if (select auth.role()) <> 'service_role'
     or p_organization_id is null or p_user_id is null
     or pg_catalog.char_length(coalesce(p_refresh_token, '')) not between 20 and 4096
     or pg_catalog.char_length(coalesce(p_scopes, '')) > 2000
     or pg_catalog.char_length(coalesce(p_account_email, '')) > 320
     or pg_catalog.char_length(coalesce(p_root_folder_id, '')) > 256 then
    raise exception 'invalid oauth completion' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organization_memberships membership
    join public.organization_role_grants role
      on role.organization_id = membership.organization_id and role.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id = p_user_id and membership.status = 'active'
      and role.role in ('admin', 'vp')
  ) then raise exception 'not authorized' using errcode = '42501'; end if;
  select nullif(credential_ref, '')::uuid into old_ref
  from public.organization_integrations
  where organization_id = p_organization_id and provider = 'google_drive';
  secret_id := vault.create_secret(
    p_refresh_token,
    'google-drive-' || p_organization_id::text || '-' || extensions.gen_random_uuid()::text,
    'Organization-owned Google Drive OAuth refresh token'
  );
  insert into public.organization_integrations (
    organization_id, provider, status, account_owner, default_settings, credential_ref
  ) values (
    p_organization_id, 'google_drive', 'connected', 'organization',
    pg_catalog.jsonb_build_object(
      'accountEmail', nullif(pg_catalog.btrim(coalesce(p_account_email, '')), ''),
      'rootFolderId', nullif(pg_catalog.btrim(coalesce(p_root_folder_id, '')), ''),
      'scopes', p_scopes
    ), secret_id::text
  ) on conflict (organization_id, provider) do update
    set status = 'connected', account_owner = 'organization',
        default_settings = excluded.default_settings,
        credential_ref = excluded.credential_ref,
        last_error_code = null,
        updated_at = pg_catalog.now();
  if old_ref is not null and old_ref is distinct from secret_id then
    delete from vault.secrets where id = old_ref;
  end if;
  perform private.mi1_write_tenant_audit(p_organization_id, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id, 'provider', 'google_drive', 'status', 'connected',
    'accountEmail', nullif(pg_catalog.btrim(coalesce(p_account_email, '')), '')
  ));
  return pg_catalog.jsonb_build_object('status', 'connected', 'provider', 'google_drive');
end;
$function$;

create function public.read_google_drive_refresh_token(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  integration public.organization_integrations%rowtype;
  token text;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into integration from public.organization_integrations
  where organization_id = p_organization_id and provider = 'google_drive'
    and status = 'connected' and credential_ref is not null;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  select secret.decrypted_secret into token from vault.decrypted_secrets secret
  where secret.id = integration.credential_ref::uuid;
  if token is null then raise exception 'credential unavailable' using errcode = '55000'; end if;
  return pg_catalog.jsonb_build_object(
    'refreshToken', token,
    'rootFolderId', integration.default_settings ->> 'rootFolderId'
  );
end;
$function$;

create function public.disconnect_google_drive()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  secret_ref uuid;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  select nullif(credential_ref, '')::uuid into secret_ref
  from public.organization_integrations
  where organization_id = org and provider = 'google_drive' for update;
  update public.organization_integrations
  set status = 'revoked', credential_ref = null, default_settings = '{}'::jsonb,
      last_error_code = null, updated_at = pg_catalog.now()
  where organization_id = org and provider = 'google_drive';
  if secret_ref is not null then delete from vault.secrets where id = secret_ref; end if;
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', 'google_drive', 'status', 'revoked'
  ));
  return public.get_google_drive_activation();
end;
$function$;

create or replace function private.mi1_integration_allowed_chapter_override_keys(p_provider text)
returns text[]
language sql
immutable
security definer
set search_path = ''
as $function$
  select case p_provider
    when 'twilio' then array['fromNumber']::text[]
    when 'google_calendar' then array['calendarId']::text[]
    when 'microsoft_calendar' then array['calendarId']::text[]
    when 'constant_contact' then array['listId']::text[]
    when 'cba_ingest' then array['library']::text[]
    when 'google_drive' then array[]::text[]
    else array[]::text[]
  end
$function$;

revoke all on function public.list_knowledge_collections() from public, anon, authenticated, service_role;
revoke all on function public.save_knowledge_collection(uuid, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.set_knowledge_collection_item(uuid, text, uuid, boolean, integer) from public, anon, authenticated, service_role;
revoke all on function public.delete_knowledge_collection(uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_chapter_kb_revisions(uuid) from public, anon, authenticated, service_role;
revoke all on function public.restore_chapter_kb_revision(uuid, bigint, boolean, uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_knowledge_file_storage_target(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.cancel_steward_library_upload(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.authorize_knowledge_ingest(uuid) from public, anon, authenticated, service_role;
revoke all on function public.replace_knowledge_source_chunks(uuid, uuid, uuid, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.begin_google_drive_oauth(text, text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.get_google_drive_activation() from public, anon, authenticated, service_role;
revoke all on function public.authorize_google_drive_operation(text) from public, anon, authenticated, service_role;
revoke all on function public.claim_google_drive_oauth_state(text) from public, anon, authenticated, service_role;
revoke all on function public.complete_google_drive_oauth(uuid, uuid, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.read_google_drive_refresh_token(uuid) from public, anon, authenticated, service_role;
revoke all on function public.disconnect_google_drive() from public, anon, authenticated, service_role;

grant execute on function public.list_knowledge_collections() to authenticated;
grant execute on function public.save_knowledge_collection(uuid, text, text, text, text) to authenticated;
grant execute on function public.set_knowledge_collection_item(uuid, text, uuid, boolean, integer) to authenticated;
grant execute on function public.delete_knowledge_collection(uuid) to authenticated;
grant execute on function public.list_chapter_kb_revisions(uuid) to authenticated;
grant execute on function public.restore_chapter_kb_revision(uuid, bigint, boolean, uuid) to authenticated;
grant execute on function public.get_knowledge_file_storage_target(uuid, uuid, text) to authenticated;
grant execute on function public.cancel_steward_library_upload(uuid, uuid) to authenticated;
grant execute on function public.authorize_knowledge_ingest(uuid) to authenticated;
grant execute on function public.replace_knowledge_source_chunks(uuid, uuid, uuid, jsonb, text) to service_role;
grant execute on function public.begin_google_drive_oauth(text, text, text, timestamptz) to authenticated;
grant execute on function public.get_google_drive_activation() to authenticated;
grant execute on function public.authorize_google_drive_operation(text) to authenticated;
grant execute on function public.disconnect_google_drive() to authenticated;
grant execute on function public.claim_google_drive_oauth_state(text) to service_role;
grant execute on function public.complete_google_drive_oauth(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.read_google_drive_refresh_token(uuid) to service_role;

comment on table public.knowledge_collections is
  'Organization/chapter-scoped reusable knowledge placements; direct writes are denied.';
comment on table public.knowledge_collection_items is
  'Ordered links from collections to current KB articles or protected knowledge files.';
comment on table private.google_drive_oauth_states is
  'Short-lived PKCE state for an organization-owned Google Drive activation.';
