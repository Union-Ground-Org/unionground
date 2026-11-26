-- UX-UG-HALF-DONE-THE-MICROSITE-HIERARCHY-EDITOR-DEAD-ENDS-AT-PUBLIC-CHAPTER-PROFILE-20260921
--
-- The public chapter microsite editor dead-ended at 'Public chapter profile
-- required': the whole public surface reads the published kind='chapter'
-- public_site_records row, but no product UI or RPC could create it — the only
-- INSERT was the demo seed. The hierarchy editor itself already writes through
-- SECURITY DEFINER routines gated by the chapter-publishing staff role (see
-- 20260920010000_public_chapter_microsite_rpc_only_writes for the RPC-only
-- house rule). Add the missing profile write the same way: one bounded definer
-- RPC that inserts or updates the caller's organization's published chapter
-- profile, bound to a real chapter identity, and revokes direct execution the
-- same way the sibling microsite RPCs do. The chapter-creation and bootstrap
-- RPCs accept chapter ids matching '^[a-z0-9][a-z0-9-]{0,31}$', so one- and
-- two-character ids are valid product input; the profile insert copies the
-- chapter id into public_site_records.id, whose bound required three
-- characters and would reject every profile save for such a chapter. Widen
-- the bound to cover the chapter id space. Canonical bootstrap chapters have
-- no region, and the original public_site_records_shape constraint required
-- non-NULL regions for every kind='chapter' row, so this migration also
-- replaces that constraint: a chapter row may carry either both localized
-- regions or neither. Finally, the editor projection already carries the
-- profile's updated_at; the upsert takes it as the expected version and
-- refuses a stale two-editor submit instead of silently overwriting the first
-- save. A form loaded while the profile was absent says so explicitly with
-- p_expected_missing, so two staff racing to create it cannot silently
-- overwrite each other either: the second create sees an existing row and is
-- refused. The table is small, so the re-validation scans are cheap.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Regionless chapters stay publishable: canonical bootstrap chapters have no
-- region and the public renderer omits a missing one, so the profile insert
-- copies the chapter's own region or NULL — never a fabricated geography.
-- Copy-only edits of an existing profile must also preserve the localized
-- region_en/region_es values this form does not display, so the conflict
-- update never touches the region columns.

-- Widen before the write path exists so a one- or two-character chapter id
-- can never hit the old three-character floor during apply.
alter table public.public_site_records
  drop constraint public_site_records_id_bounded;
alter table public.public_site_records
  add constraint public_site_records_id_bounded check (
    id ~ '^[a-z0-9][a-z0-9-]{0,63}$'
  );

-- Canonical bootstrap chapters legitimately have no region, and the public
-- renderer omits a missing one, but the original public_site_records_shape
-- constraint required region_en/region_es to be non-NULL for every
-- kind='chapter' row — so a regionless chapter's profile insert failed the
-- check instead of publishing. Replace it: a chapter row may carry either both
-- localized regions or neither; the win/meeting arms are unchanged. Adding
-- the constraint without NOT VALID re-scans the small table and validates.
alter table public.public_site_records
  drop constraint public_site_records_shape;
alter table public.public_site_records
  add constraint public_site_records_shape check (
    (kind = 'chapter'
      and (
        region_en is not null and region_es is not null
        or region_en is null and region_es is null
      )
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
  );

create function public.upsert_public_chapter_profile(
  p_chapter_code text,
  p_title_en text,
  p_title_es text,
  p_body_en text,
  p_body_es text,
  p_is_published boolean,
  p_expected_updated_at timestamptz,
  p_expected_missing boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  organization uuid;
  chapter public.chapters%rowtype;
  target_id text;
  v_region text;
  existing record;
begin
  -- public_site_records is in the account case graph: take the case-graph
  -- lock before any permission read, row acquisition or DML.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  organization := private.current_member_organization();
  target_id := pg_catalog.lower(pg_catalog.btrim(p_chapter_code));
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.organization_coordination_is_staff(organization) then
    raise exception 'chapter publishing role required' using errcode = '42501';
  end if;
  -- Every save names the state the form loaded: absent (create) or a projected
  -- version (edit). A NULL version is never an unconditional overwrite.
  if p_expected_missing is null
    or p_expected_missing is distinct from (p_expected_updated_at is null) then
    raise exception 'chapter profile expected state required' using errcode = '22023';
  end if;
  -- The chapter must belong to the caller's own organization: a foreign
  -- chapter id must never be claimable, even when it has no profile yet.
  select * into chapter from public.chapters
  where chapters.id = target_id
    and chapters.organization_id = organization;
  if not found then
    raise exception 'chapter unavailable' using errcode = '22023';
  end if;
  -- The public chapter card displays region_en/region_es. Canonical bootstrap
  -- chapters legitimately have region NULL, and the public renderer omits a
  -- missing region, so copy the chapter's own region or NULL; never substitute
  -- a demo geography when the chapter has none.
  v_region := nullif(pg_catalog.btrim(coalesce(chapter.region, '')), '');
  select record.kind, record.organization_id into existing
  from public.public_site_records record where record.id = target_id;
  -- A profile may only ever be written for the caller's own organization, and
  -- a non-chapter record id can never be claimed by a chapter profile.
  if found then
    if existing.kind <> 'chapter'
       or existing.organization_id is distinct from organization then
      raise exception 'chapter profile unavailable' using errcode = '22023';
    end if;
  elsif not p_expected_missing then
    -- An edit form projected a version, but the row is gone: never recreate
    -- it from a stale form.
    raise exception 'chapter profile changed since load' using errcode = '23000';
  end if;
  insert into public.public_site_records (
    id, kind, title_en, title_es, body_en, body_es,
    region_en, region_es, sort_order, is_published, published_at,
    created_by, organization_id, chapter_code
  ) values (
    target_id, 'chapter',
    pg_catalog.btrim(p_title_en), pg_catalog.btrim(p_title_es),
    pg_catalog.btrim(p_body_en), pg_catalog.btrim(p_body_es),
    v_region,
    v_region,
    chapter.order_index, p_is_published,
    case when p_is_published then pg_catalog.clock_timestamp() else null end,
    caller, organization, target_id
  -- Copy-only edits never rewrite the localized region columns: an existing
  -- profile may carry translated region_en/region_es values the form neither
  -- displays nor edits, and overwriting them here would destroy public content
  -- without the operator's knowledge. Regions are set only by the insert arm.
  -- The expected-version guard refuses a stale submit: when the form loaded,
  -- the editor projected updated_at; a second editor's save after that point
  -- must surface as a conflict instead of silently overwriting the first save.
  -- A form that loaded the missing state never updates: a row that appeared
  -- since load is another editor's create and must be refused, not replaced.
  ) on conflict (id) do update
    set title_en = excluded.title_en,
        title_es = excluded.title_es,
        body_en = excluded.body_en,
        body_es = excluded.body_es,
        is_published = excluded.is_published,
        published_at = case when excluded.is_published
          then coalesce(public.public_site_records.published_at, pg_catalog.clock_timestamp())
          else null end,
        updated_at = pg_catalog.clock_timestamp()
    where public.public_site_records.kind = 'chapter'
      and public.public_site_records.organization_id = organization
      and not p_expected_missing
      and public.public_site_records.updated_at = p_expected_updated_at;
  -- A concurrent insert of a foreign win/meeting/profile with this id makes
  -- the unrestricted conflict update rewrite that row. The WHERE keeps the
  -- write on the caller's own chapter profile; no affected row means refuse.
  -- A row that exists for this chapter when the form loaded it as missing, or
  -- with a different updated_at than the form projected, is a stale-submit
  -- conflict, not an unavailable profile.
  if not found then
    perform 1 from public.public_site_records record
    where record.id = target_id and record.kind = 'chapter'
      and record.organization_id = organization
      and (p_expected_missing
        or record.updated_at is distinct from p_expected_updated_at);
    if found then
      raise exception 'chapter profile changed since load' using errcode = '23000';
    end if;
    raise exception 'chapter profile unavailable' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object(
    'saved', true, 'chapterCode', target_id,
    'published', p_is_published
  );
end;
$function$;

-- The ready-state editor projection must carry the saved profile copy and
-- publication state, otherwise a draft saved through the create form could
-- never be edited or published: the upsert replaces title/body wholesale, so
-- the product UI needs the current values to offer a safe edit control.
create or replace function public.get_public_chapter_microsite_editor(
  p_chapter_code text
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
  profile_row public.public_site_records%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.organization_coordination_is_staff(organization) then
    raise exception 'chapter publishing role required' using errcode = '42501';
  end if;
  select * into profile_row from public.public_site_records chapter
  where chapter.organization_id = organization
    and chapter.id = p_chapter_code and chapter.kind = 'chapter';
  if not found then
    return pg_catalog.jsonb_build_object(
      'state', 'missing', 'chapterCode', p_chapter_code,
      'sections', '[]'::jsonb, 'pages', '[]'::jsonb,
      'attachments', '[]'::jsonb, 'takeovers', '[]'::jsonb
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'state', 'ready', 'chapterCode', p_chapter_code,
    'profile', pg_catalog.jsonb_build_object(
      'titleEn', profile_row.title_en, 'titleEs', profile_row.title_es,
      'bodyEn', profile_row.body_en, 'bodyEs', profile_row.body_es,
      'published', profile_row.is_published, 'updatedAt', profile_row.updated_at
    ),
    'sections', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'slug', section.slug,
        'titleEn', section.title_en, 'titleEs', section.title_es,
        'bodyEn', section.body_en, 'bodyEs', section.body_es,
        'sortOrder', section.sort_order,
        'published', section.is_published,
        'updatedAt', section.updated_at
      ) order by section.sort_order, section.slug)
      from public.public_chapter_sections section
      where section.organization_id = organization
        and section.chapter_code = p_chapter_code
    ), '[]'::jsonb),
    'pages', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'sectionSlug', page.section_slug, 'slug', page.slug,
        'titleEn', page.title_en, 'titleEs', page.title_es,
        'bodyEn', page.body_en, 'bodyEs', page.body_es,
        'sortOrder', page.sort_order, 'published', page.is_published,
        'updatedAt', page.updated_at
      ) order by page.section_slug, page.sort_order, page.slug)
      from public.public_chapter_pages page
      where page.organization_id = organization
        and page.chapter_code = p_chapter_code
    ), '[]'::jsonb),
    'attachments', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', attachment.id, 'sectionSlug', attachment.section_slug,
        'pageSlug', attachment.page_slug,
        'documentId', attachment.chapter_document_id,
        'label', attachment.label, 'attachedAt', attachment.attached_at
      ) order by attachment.section_slug, attachment.page_slug,
        attachment.attached_at, attachment.id)
      from public.public_chapter_page_attachments attachment
      where attachment.organization_id = organization
        and attachment.chapter_code = p_chapter_code
    ), '[]'::jsonb),
    'takeovers', case when private.has_organization_role(
      organization, array['coordinator','admin','vp']
    ) then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', takeover.id, 'sectionSlug', takeover.section_slug,
        'pageSlug', takeover.page_slug, 'reason', takeover.reason,
        'takenOverAt', takeover.taken_over_at
      ) order by takeover.taken_over_at desc, takeover.id desc)
      from public.public_chapter_page_takeovers takeover
      where takeover.organization_id = organization
        and takeover.chapter_code = p_chapter_code
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$function$;

revoke all on function public.upsert_public_chapter_profile(
  text, text, text, text, text, boolean, timestamptz, boolean
) from public, anon, authenticated, service_role;

grant execute on function public.upsert_public_chapter_profile(
  text, text, text, text, text, boolean, timestamptz, boolean
) to authenticated;

notify pgrst, 'reload schema';

commit;
