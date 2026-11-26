begin;

-- Round 5: connect 20260907110000's ledger to the existing product RPCs.
-- No client can choose reviewer, correction actor, source digest or attempt.
-- The source row lock serializes with record_knowledge_conversion; the object
-- verdict lock preserves the existing inspection boundary. Legacy sources
-- without a ledger remain legacy: this migration does not invent conversions.

alter table public.organization_knowledge_conversions
  add column parent_conversion_id uuid references public.organization_knowledge_conversions(id) on delete restrict,
  add column corrected_article_id uuid references public.member_kb_articles(id) on delete restrict,
  add column corrected_article_version integer,
  add column corrected_by uuid references auth.users(id) on delete restrict,
  add constraint knowledge_conversion_correction_binding check (
    (parent_conversion_id is null and corrected_article_id is null
      and corrected_article_version is null and corrected_by is null)
    or (change_kind = 'manual-correction' and parent_conversion_id is not null
      and corrected_article_id is not null and corrected_article_version > 0
      and corrected_by is not null)
  );

create index knowledge_conversion_parent_idx on public.organization_knowledge_conversions(parent_conversion_id);
create index knowledge_conversion_article_idx on public.organization_knowledge_conversions(corrected_article_id, corrected_article_version);
create index knowledge_conversion_actor_idx on public.organization_knowledge_conversions(corrected_by);

-- Freeze future provenance columns too, including the correction's parent and
-- exact article/version. The only mutable fields remain the one-time signature.
create or replace function private.knowledge_conversion_is_append_only()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if (pg_catalog.to_jsonb(new) - 'conversion_reviewed_at' - 'conversion_reviewed_by')
     is distinct from
     (pg_catalog.to_jsonb(old) - 'conversion_reviewed_at' - 'conversion_reviewed_by') then
    raise exception 'knowledge conversion provenance is immutable' using errcode = '42501';
  end if;
  if old.conversion_reviewed_at is not null
     and (new.conversion_reviewed_at is distinct from old.conversion_reviewed_at
          or new.conversion_reviewed_by is distinct from old.conversion_reviewed_by) then
    raise exception 'knowledge conversion review is recorded once' using errcode = '42501';
  end if;
  return new;
end;
$function$;

create function private.record_knowledge_workflow_provenance(
  p_source_id uuid, p_article_id uuid, p_article_version integer,
  p_manual_correction boolean, p_review boolean
)
returns void language plpgsql security definer set search_path = '' as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  actor uuid := (select auth.uid());
  source public.organization_knowledge_sources%rowtype;
  previous public.organization_knowledge_conversions%rowtype;
  current_id uuid;
  next_attempt integer;
  digest text;
begin
  if actor is null or not private.mfa_satisfied()
     or not private.has_organization_role(org, array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into source from public.organization_knowledge_sources
  where id = p_source_id and organization_id = org for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  select * into previous from public.organization_knowledge_conversions
  where source_id = source.id order by attempt desc limit 1;
  if not found then return; end if;
  if not private.knowledge_source_object_verdict_locked(org, source.id) then
    raise exception 'file inspection required' using errcode = '42501';
  end if;
  select content_sha256 into digest from public.organization_knowledge_files where id = source.file_id;
  if previous.outcome <> 'succeeded' or previous.source_sha256 is distinct from digest then
    raise exception 'conversion is not current for this source' using errcode = '42501';
  end if;
  next_attempt := previous.attempt + 1;
  -- File publication reviews the extraction; article publication reviews that
  -- article's latest correction (or extraction). Another article's correction
  -- must never lend its signature to this one.
  select * into previous from public.organization_knowledge_conversions
  where source_id = source.id
    and (change_kind <> 'manual-correction' or corrected_article_id = p_article_id)
  order by attempt desc limit 1;
  if not found then raise exception 'conversion binding is unavailable' using errcode = '42501'; end if;
  current_id := previous.id;
  if p_manual_correction then
    if not exists (select 1 from public.member_kb_articles
      where id = p_article_id and version = p_article_version
        and knowledge_source_id = source.id and content_origin = 'derived') then
      raise exception 'correction is not bound to this article version' using errcode = '42501';
    end if;
    insert into public.organization_knowledge_conversions (
      organization_id, source_id, file_id, attempt, source_sha256, source_byte_size,
      source_format, converter_name, converter_version, pipeline_version,
      outcome, change_kind, conversion_metadata, parent_conversion_id,
      corrected_article_id, corrected_article_version, corrected_by
    ) values (
      org, source.id, source.file_id, next_attempt, previous.source_sha256,
      previous.source_byte_size, previous.source_format, previous.converter_name,
      previous.converter_version, previous.pipeline_version, 'succeeded',
      'manual-correction', '{}'::jsonb, previous.id, p_article_id, p_article_version, actor
    ) returning id into current_id;
  end if;
  if p_review and (p_manual_correction or previous.conversion_reviewed_at is null) then
    perform public.review_knowledge_conversion(org, current_id);
  end if;
end;
$function$;
revoke all on function private.record_knowledge_workflow_provenance(uuid, uuid, integer, boolean, boolean)
  from public, anon, authenticated, service_role;
comment on function private.record_knowledge_workflow_provenance(uuid, uuid, integer, boolean, boolean) is
  'Internal transaction hook for existing authorized publication and correction RPCs. Locks the source, checks current inspection and conversion bytes, attributes a correction to auth.uid and its exact article version, and signs the corresponding successful attempt once.';

create or replace function public.review_steward_library_file(p_file_id uuid, p_decision text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  file public.organization_knowledge_files%rowtype;
  conversion_source uuid;
  next_status text;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_decision not in ('approved', 'rejected', 'quarantined') then
    raise exception 'invalid review decision' using errcode = '22023';
  end if;
  select * into file from public.organization_knowledge_files where id = p_file_id;
  if not found or file.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if p_decision = 'approved' and file.storage_kind = 'organization_storage'
     and not private.private_upload_is_current('organization-knowledge', file.storage_path) then
    raise exception 'file inspection required' using errcode = '42501';
  end if;
  if p_decision = 'approved' then
    for conversion_source in select id from public.organization_knowledge_sources
      where file_id = file.id and organization_id = org order by id
    loop
      perform private.record_knowledge_workflow_provenance(conversion_source, null, null, false, true);
    end loop;
  end if;
  next_status := p_decision;
  update public.organization_knowledge_files
  set review_status = next_status,
      index_status = case when next_status = 'approved' then 'skipped_unset' else index_status end,
      updated_at = pg_catalog.now()
  where id = file.id;
  perform private.mi1_w2_write_audit(org, 'knowledge_file_reviewed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'fileId', file.id, 'reviewStatus', next_status, 'action', 'reviewed'
  ));
  return private.mi1_w2_project_knowledge_file(file.id);
end;
$function$;

create or replace function public.publish_steward_file_to_catalog(p_file_id uuid, p_category text, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  file public.organization_knowledge_files%rowtype;
  conversion_source uuid;
  cached jsonb;
  cached_request jsonb;
  request_payload jsonb := pg_catalog.jsonb_build_object(
    'fileId', p_file_id, 'category', coalesce(p_category, '')
  );
  result jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'publish_steward_file_to_catalog:' || org::text || ':' || p_idempotency_key::text, 509
  ));
  select receipt.result, receipt.request_payload into cached, cached_request
  from private.mi1_w2_operation_receipts receipt
  where receipt.organization_id = org and receipt.operation = 'publish_steward_file_to_catalog'
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if cached_request is distinct from request_payload then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    return cached;
  end if;
  select * into file from public.organization_knowledge_files where id = p_file_id;
  if not found or file.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  -- Was `file.scan_status <> 'clean'`, a stale row flag written by the text
  -- extractor. The verdict is now read from the ledger, bound to this object's
  -- identity and version.
  if file.review_status <> 'approved'
     or (file.storage_kind = 'organization_storage'
       and not private.private_upload_is_current('organization-knowledge', file.storage_path)) then
    raise exception 'only approved clean files can be published' using errcode = '22023';
  end if;
  if true then
    for conversion_source in select id from public.organization_knowledge_sources
      where file_id = file.id and organization_id = org order by id
    loop
      perform private.record_knowledge_workflow_provenance(conversion_source, null, null, false, true);
    end loop;
  end if;
  update public.organization_knowledge_files
  set published_to_catalog = true,
      visibility = 'organization',
      category = coalesce(nullif(p_category, ''), category),
      updated_at = pg_catalog.now()
  where id = file.id;
  perform private.mi1_w2_write_audit(org, 'knowledge_file_published_to_catalog', pg_catalog.jsonb_build_object(
    'organizationId', org, 'fileId', file.id, 'library', 'catalog',
    'category', coalesce(nullif(p_category, ''), file.category), 'action', 'published'
  ));
  result := private.mi1_w2_project_knowledge_file(file.id);
  insert into private.mi1_w2_operation_receipts (
    organization_id, operation, idempotency_key, request_payload, result
  ) values (org, 'publish_steward_file_to_catalog', p_idempotency_key, request_payload, result);
  return result;
end;
$function$;

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
  manual_correction boolean := false;
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
      verified_by, verified_at, updated_at, content_origin
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
      pg_catalog.now(),
      -- Stated, never defaulted. A new article typed by staff has no Storage
      -- provenance and cannot acquire one here: the column list above does not
      -- mention knowledge_source_id, and 'authored' requires it to be null.
      'authored'
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

    -- The second publication route to a Storage-derived row, now gated on the
    -- whole withholding predicate. Its two halves keep the two refusal shapes
    -- this record already established, and neither is an oracle:
    --   * A WITHHELD article answers exactly as an absent one does. Its text
    --     cannot be proved to have come from the source it names, so it may
    --     not be edited, re-published or re-verified, and saying so distinctly
    --     would report the existence of content that is being withheld.
    --   * A lapsed verdict keeps 42501 'file inspection required', for exactly
    --     the reason restore_chapter_kb_revision refuses it, with the same
    --     SQLSTATE and the same message.
    -- Authored articles carry a null knowledge_source_id and stay editable.
    if not private.knowledge_article_content_current(saved) then
      if saved.content_origin = 'unresolved' then
        raise exception 'knowledge article is not available in this chapter' using errcode = '42501';
      end if;
      raise exception 'file inspection required' using errcode = '42501';
    end if;

    manual_correction := (saved.kind, saved.title, saved.article_ref, saved.body, saved.keywords)
      is distinct from (clean_kind, clean_title, clean_ref, clean_body, clean_keywords);
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
    keywords, changed_by, verified_by, verified_at,
    content_origin, knowledge_source_id
  ) values (
    saved.id, saved.chapter_id, saved.version, saved.status, saved.kind,
    saved.title, saved.article_ref, saved.body, saved.keywords, caller,
    saved.verified_by, saved.verified_at,
    saved.content_origin,
    saved.knowledge_source_id
  );

  if saved.knowledge_source_id is not null then
    perform private.record_knowledge_workflow_provenance(
      saved.knowledge_source_id, saved.id, saved.version, manual_correction, saved.status = 'published');
  end if;
  return saved;
end;
$function$;

create or replace function public.restore_chapter_kb_revision(
  p_article_id uuid,
  p_revision_id bigint,
  p_confirm_verified boolean,
  p_idempotency_key uuid,
  p_chapter_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  requested_chapter text := nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), '');
  chapter text := coalesce(requested_chapter, private.current_member_chapter());
  actor uuid := (select auth.uid());
  article public.member_kb_articles%rowtype;
  revision public.member_kb_article_revisions%rowtype;
  restored public.member_kb_articles%rowtype;
  next_status text;
  restored_source uuid;
  restored_origin text;
  reestablishing boolean := false;
  lifecycle jsonb;
  request_payload jsonb := pg_catalog.jsonb_build_object(
    'articleId', p_article_id, 'revisionId', p_revision_id,
    'confirmVerified', coalesce(p_confirm_verified, false),
    'actorId', actor
  ) || case when requested_chapter is null then '{}'::jsonb
            else pg_catalog.jsonb_build_object('chapterId', chapter) end;
  cached jsonb;
  cached_request jsonb;
begin
  if not private.mfa_satisfied()
     or not private.mi1_knowledge_collection_staff(org)
     or chapter is null
     or not private.mi1_w2_same_org_chapter(org, chapter)
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
    return private.knowledge_revision_restore_receipt(chapter, cached);
  end if;
  select * into article from public.member_kb_articles source
  where source.id = p_article_id and source.chapter_id = chapter and not source.is_sample
  for update;
  select * into revision from public.member_kb_article_revisions source
  where source.id = p_revision_id and source.article_id = p_article_id and source.chapter_id = chapter;
  if article.id is null or revision.id is null then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  -- An unresolved row is not authored and is not attributable. It is hidden by
  -- list_chapter_kb_revisions, so it answers with the same refusal a revision
  -- that is not there answers with: distinguishing them would turn this RPC
  -- into an oracle for withheld history.
  if revision.content_origin = 'unresolved' then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  -- THE ARTICLE-LEVEL WITHHOLDING, AND ITS ONE DOOR (20260906030000).
  -- A withheld article answers with the same P0002 an article that is not
  -- there answers with, so this RPC is not an oracle for withheld text. The
  -- single exception is the reviewed re-establishment: the version-zero
  -- candidate a later reconciliation staged out of its OWN inspected bytes.
  -- That candidate's text belongs to the incoming source, not to the withheld
  -- article, so admitting it discloses nothing that was withdrawn — and it is
  -- the only way a withheld article ever becomes readable again.
  --
  -- The other half of the predicate keeps the shape this record already
  -- established: an article whose own source has lapsed is refused 42501
  -- 'file inspection required', exactly as before.
  if not private.knowledge_article_content_current(article) then
    if article.content_origin = 'unresolved' then
      if revision.id is distinct from
         (private.knowledge_article_reestablishment_candidate(article)).id then
        raise exception 'not found' using errcode = 'P0002';
      end if;
      reestablishing := true;
    else
      raise exception 'file inspection required' using errcode = '42501';
    end if;
  end if;
  -- Publication of storage-derived language needs a live verdict for the file
  -- the language came from. The candidate revision's OWN source is checked
  -- here, always: on the ordinary path the article's own source was checked by
  -- the predicate above, and on the re-establishment path the article's own
  -- source is precisely the claim this record has withdrawn, so it gates
  -- nothing. Authored revisions carry a null source, and authored articles and
  -- non-Storage sources (external_url, inline text, Drive) answer true and keep
  -- their semantics unchanged.
  if not private.knowledge_source_verdict_current(revision.knowledge_source_id) then
    raise exception 'file inspection required' using errcode = '42501';
  end if;
  -- The restored article takes the REVISION's own content source. The previous
  -- body wrote coalesce(revision.knowledge_source_id, article.knowledge_source_id),
  -- which stamped an unrelated current source onto republished text from a
  -- different file. An authored revision restores an authored article.
  restored_source := case
    when revision.content_origin = 'derived' then revision.knowledge_source_id
    else null
  end;
  -- The article's origin is taken from the revision being restored, never from
  -- what the article carried before. It is therefore 'authored' or 'derived'
  -- and NEVER 'unresolved': an unresolved revision was already refused above,
  -- so nothing this function writes can create a withheld row — it can only
  -- resolve one, which is what the re-establishment path is.
  restored_origin := case when restored_source is null then 'authored' else 'derived' end;
  -- Under the writer rules 20260906028000 establishes, a derived article only
  -- ever holds derived revisions and an authored article only ever holds
  -- authored ones, so this cannot fire on the ordinary path. It is written as a
  -- refusal rather than a silent adjustment because the alternative is
  -- rewriting import_key to keep member_kb_articles_import_provenance_complete
  -- satisfied, which would detach a clause from the lineage a later
  -- reconciliation reconciles against.
  --
  -- The re-establishment path is deliberately exempt, because it IS a change of
  -- origin: from the withdrawn 'unresolved' to the candidate's own 'derived'.
  -- Its shapes agree anyway — a withheld article that a reconciliation could
  -- reach carries a non-null knowledge_source_id and import_key by construction,
  -- and the candidate is derived — so the exemption changes no outcome; it is
  -- written out so the intent is not re-derived later as a defect.
  if not reestablishing
     and (restored_source is null) is distinct from (article.knowledge_source_id is null) then
    raise exception 'revision provenance does not match this article' using errcode = '22023';
  end if;

  if revision.import_candidate_key is not null
     and revision.status = 'retired'
     and not coalesce(p_confirm_verified, false) then
    delete from public.member_kb_article_revisions candidate
    where candidate.id = revision.id and candidate.import_candidate_key is not null;
    lifecycle := pg_catalog.jsonb_build_object(
      'articleId', article.id, 'newVersion', article.version,
      'status', article.status, 'restoredRevisionId', revision.id,
      'action', 'retirement_dismissed'
    );
    insert into private.mi1_w2_operation_receipts (
      organization_id, operation, idempotency_key, request_payload, result
    ) values (org, 'restore_chapter_kb_revision', p_idempotency_key, request_payload, lifecycle);
    perform private.mi1_w2_write_audit(org, 'knowledge_revision_restored', pg_catalog.jsonb_build_object(
      'organizationId', org, 'articleId', article.id,
      'restoredRevisionId', revision.id, 'restoredFromVersion', revision.version,
      'newVersion', article.version, 'status', article.status,
      'action', 'retirement_dismissed'
    ));
    return pg_catalog.to_jsonb(article);
  end if;

  next_status := case
    when revision.import_candidate_key is not null
      and revision.status = 'retired'
      and coalesce(p_confirm_verified, false) then 'retired'
    when revision.status in ('draft', 'published')
      and coalesce(p_confirm_verified, false) then 'published'
    else 'draft'
  end;
  update public.member_kb_articles
  set kind = revision.kind,
      title = revision.title,
      article_ref = revision.article_ref,
      body = revision.body,
      keywords = revision.keywords,
      status = next_status,
      version = article.version + 1,
      knowledge_source_id = restored_source,
      content_origin = restored_origin,
      updated_by = actor,
      verified_by = case when next_status = 'published' then actor else null end,
      verified_at = case when next_status = 'published' then pg_catalog.now() else null end,
      updated_at = pg_catalog.now()
  where id = article.id returning * into restored;
  if revision.import_candidate_key is not null then
    delete from public.member_kb_article_revisions candidate where candidate.id = revision.id;
  end if;
  if restored.knowledge_source_id is not null then
    perform private.record_knowledge_workflow_provenance(
      restored.knowledge_source_id, restored.id, restored.version, true, restored.status = 'published');
  end if;

  -- The new canonical revision inherits the restored article's origin, so
  -- republishing derived text through review keeps it bound to its file.
  insert into public.member_kb_article_revisions (
    article_id, chapter_id, version, status, kind, title, article_ref, body,
    keywords, changed_by, verified_by, verified_at,
    content_origin, knowledge_source_id
  ) values (
    restored.id, restored.chapter_id, restored.version, restored.status,
    restored.kind, restored.title, restored.article_ref, restored.body,
    restored.keywords, actor, restored.verified_by, restored.verified_at,
    restored.content_origin,
    restored.knowledge_source_id
  );
  lifecycle := pg_catalog.jsonb_build_object(
    'articleId', restored.id, 'newVersion', restored.version,
    'status', restored.status, 'restoredRevisionId', revision.id,
    'action', case when restored.status = 'retired' then 'retirement_confirmed' else 'revision_restored' end
  );
  insert into private.mi1_w2_operation_receipts (
    organization_id, operation, idempotency_key, request_payload, result
  ) values (org, 'restore_chapter_kb_revision', p_idempotency_key, request_payload, lifecycle);
  perform private.mi1_w2_write_audit(org, 'knowledge_revision_restored', pg_catalog.jsonb_build_object(
    'organizationId', org, 'articleId', restored.id,
    'restoredRevisionId', revision.id, 'restoredFromVersion', revision.version,
    'newVersion', restored.version, 'status', restored.status,
    'action', case when restored.status = 'retired' then 'retirement_confirmed' else 'revision_restored' end
  ));
  return pg_catalog.to_jsonb(restored);
end;
$function$;

commit;
