begin;

-- SEC-UG-CLEANROOM-UPLOAD-SECURITY-20260904 — slice 4, fifth repair.
--
-- 20260906024000 gated the write half and the staff half of the
-- storage-derived knowledge lifecycle; 20260906026000 gated the member-facing
-- half — the article snapshot that carries the clause body, the two
-- `member_kb_articles` read policies, the second publication route and the
-- collection surfaces. An independent round-2 verification then found the last
-- reader that carried no provenance conjunct at all:
--
--   `public.retire_chapter_kb_article` is granted EXECUTE to `authenticated`
--   and is declared `returns public.member_kb_articles`, so a chapter staff
--   caller received the WHOLE row — slug, title, article_ref, body, keywords —
--   for a Storage-derived article whose originating object had been deleted and
--   whose ledger row was tombstoned `deleted`. It was proved live in the same
--   transaction in which `search_member_kb`, both article snapshots, the direct
--   RLS select on `member_kb_articles`, `list_chapter_kb_revisions`,
--   `list_knowledge_collections`, `restore_chapter_kb_revision` and
--   `save_chapter_kb_article` all refused. The table's new read-policy conjunct
--   does not constrain it: `public` owns the table with FORCE ROW LEVEL
--   SECURITY, but this body runs security definer as `postgres`, which holds
--   BYPASSRLS.
--
-- THE DECISION THIS MIGRATION RECORDS. Two shapes close it. Refusing outright
-- with `42501 file inspection required`, like the two publication routes, would
-- also strand a published clause that nobody can retire for as long as its
-- source stays lapsed — and a lapse is exactly when staff most want the clause
-- off the shelf. Retirement is a REMOVAL-shaped operation, the same class as
-- the collection REMOVE path 20260906026000 deliberately left reachable, so
-- this migration keeps it callable and takes away the half that leaks:
--
--   * The retirement still happens. Status moves to 'retired', the version
--     advances and the immutable revision is still appended, so staff cleanup
--     works during a lapse exactly as it does when the verdict is current.
--   * The RETURN carries no article content for a lapsed source. `title`,
--     `article_ref`, `body` and `keywords` — every field that carries text
--     lifted out of the file — are nulled in the returned composite. The stored
--     row is NOT rewritten: a re-inspection that restores the verdict restores
--     the article intact, and the gate is about what crosses the boundary, not
--     about destroying evidence.
--   * The identity and lifecycle fields survive (`id`, `slug`, `chapter_id`,
--     `kind`, `order_index`, `status`, `version`, `knowledge_source_id`,
--     `import_key`, the audit columns), because the caller has to be able to
--     reconcile the row it just retired. `slug` and `import_key` embed the
--     extractor's clause key, which is minted from the heading KIND and NUMBER
--     (`cbaClauseKey` in api/_lib/knowledgeIngest.js — 'article:i'), never from
--     document prose; the heading's own words live in `title`, which is nulled.
--   * Authored, null-provenance articles are untouched. They keep today's
--     behaviour on every field, because
--     `private.knowledge_source_verdict_current` answers true for a null
--     `knowledge_source_id` and for any source that is not
--     `organization_storage` (invariant 6).
--
-- The appended revision keeps the faithful snapshot. It is the immutable
-- history of what was retired, and every reader of
-- `member_kb_article_revisions` is already gated: `authenticated` holds no
-- grant on the table and `public.list_chapter_kb_revisions` carries the
-- provenance conjunct since 20260906024000.
--
-- Invariants are unchanged. `private.private_upload_is_current` remains the one
-- expression consulted (invariant 7), reached through the same
-- `knowledge_source_verdict_current` wrapper every other knowledge gate uses;
-- `organization_knowledge_files.scan_status` is still not read; no caller
-- supplies a path, bucket, digest or verdict (invariant 1). Roles, chapter
-- scope, the `is_sample` exclusion, the row lock, the SQLSTATEs and every
-- earlier error message are exactly as 20260903034000 left them.

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.retire_chapter_kb_article(
  p_article_id uuid,
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
  saved public.member_kb_articles%rowtype;
  derived_lapsed boolean := false;
begin
  if caller is null
     or p_article_id is null
     or caller_chapter is null
     or not private.mi1_w2_same_org_chapter(org, caller_chapter)
     or not (
       private.mi1_knowledge_collection_staff(org)
       or (
         caller_chapter is not distinct from home_chapter
         and public.member_has_role(array['steward','coordinator','advisor','admin','vp'])
       )
     ) then
    raise exception 'knowledge article is not available in this chapter' using errcode = '42501';
  end if;

  select * into saved
  from public.member_kb_articles article
  where article.id = p_article_id
    and article.chapter_id = caller_chapter
    and not article.is_sample
  for update;

  if not found then
    raise exception 'knowledge article is not available in this chapter' using errcode = '42501';
  end if;

  -- Decided under the row lock, before anything is written, so a concurrent
  -- verdict change cannot land between the answer and the projection below.
  -- Authored articles carry a null knowledge_source_id and answer true.
  derived_lapsed := not private.knowledge_source_verdict_current(saved.knowledge_source_id);

  update public.member_kb_articles
     set status = 'retired',
         version = version + 1,
         updated_by = caller,
         updated_at = pg_catalog.now()
   where id = p_article_id
   returning * into saved;

  insert into public.member_kb_article_revisions (
    article_id, chapter_id, version, status, kind, title, article_ref, body,
    keywords, changed_by, verified_by, verified_at
  ) values (
    saved.id, saved.chapter_id, saved.version, saved.status, saved.kind,
    saved.title, saved.article_ref, saved.body, saved.keywords, caller,
    saved.verified_by, saved.verified_at
  );

  -- The read half. Retirement stays reachable during a lapse; the derived text
  -- does not cross the boundary with it. The stored row and the revision just
  -- written keep the content, and both are read only through gated surfaces.
  if derived_lapsed then
    saved.title := null;
    saved.article_ref := null;
    saved.body := null;
    saved.keywords := null;
  end if;

  return saved;
end;
$function$;

-- `create or replace` preserves the ACL; the grant is re-stated so this
-- surface is readable in one file rather than three.
revoke all on function public.retire_chapter_kb_article(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.retire_chapter_kb_article(uuid, text)
  to authenticated;

comment on function public.retire_chapter_kb_article(uuid, text) is
  'Soft-retires a Compass source in the caller current chapter or an explicitly selected same-organization chapter authorized to organization staff; retirement stays reachable when the originating Storage source has lost its current ledger verdict, but the returned row then carries no title, article_ref, body or keywords.';

notify pgrst, 'reload schema';
commit;
