// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cba = readFileSync(new URL("../supabase/migrations/20260903030000_cba_ingestion_completion.sql", import.meta.url), "utf8");
const calendar = readFileSync(new URL("../supabase/migrations/20260903031000_calendar_import_completion.sql", import.meta.url), "utf8");
const parity = readFileSync(new URL("../supabase/migrations/20260903032000_optional_provider_demo_parity.sql", import.meta.url), "utf8");
const knowledgeSnapshot = readFileSync(new URL("../supabase/migrations/20260903033000_knowledge_article_snapshot.sql", import.meta.url), "utf8");
const knowledgeChapterScope = readFileSync(new URL("../supabase/migrations/20260903034000_knowledge_selected_chapter_scope.sql", import.meta.url), "utf8");
const knowledgeCollectionBase = readFileSync(new URL("../supabase/migrations/20260903036000_knowledge_collection_review_snapshot.sql", import.meta.url), "utf8");
const knowledgeCollectionScope = readFileSync(new URL("../supabase/migrations/20260903040000_knowledge_collection_chapter_snapshot.sql", import.meta.url), "utf8");

describe("optional provider completion boundaries", () => {
  it("keeps CBA normalization tenant/chapter scoped and review required", () => {
    expect(cba).toContain("source_file.category <> 'contract'");
    expect(cba).toContain("chapter.organization_id = p_organization_id");
    expect(cba).toContain("membership.organization_id = p_organization_id");
    expect(cba).toContain("source_file.chapter_id is distinct from p_chapter_id");
    expect(cba).toContain("pg_catalog.md5('clause:' || clean_clause_key)");
    expect(cba).toContain("'replace_cba_knowledge_drafts:' || p_organization_id::text || ':' || p_chapter_id");
    expect(cba).toContain("join public.organization_knowledge_sources prior_source");
    expect(cba).toContain("prior_file.chapter_id = p_chapter_id");
    expect(cba).toContain("pg_catalog.min(article.order_index) - 1");
    expect(cba).toContain("into base_order, lineage_end");
    expect(cba).toContain("set order_index = base_order + item.ordinality");
    expect(cba).toContain("and current_article.keywords is not distinct from clean_keywords then");
    expect(cba).toContain("current_article.id, current_article.chapter_id, 0");
    expect(cba).not.toContain("drop constraint member_kb_article_revisions_article_id_version_key");
    expect(cba).toContain("'chapterId', file.chapter_id");
    expect(cba).toContain("import_candidate_key");
    expect(cba).toContain("'publishedRetirementsStaged', retirement_staged_count");
    expect(cba).toContain("'staleCandidatesCleared', cleared_candidate_count");
    expect(cba).toContain("public.list_knowledge_review_articles_page");
    expect(cba).toContain("(source.order_index, source.id) > (p_cursor_order_index, p_cursor_id)");
    expect(cba).toContain("p_chapter_id text default null");
    expect(cba).toContain("revision.status in ('draft', 'published')");
    expect(cba).toContain("'retirement_dismissed'");
    expect(cba).toContain("'importCandidate', revision.import_candidate_key is not null");
    expect(cba).toContain("p_chapter_id, 'draft', false");
    expect(cba).toContain("article.order_index + lineage_growth");
    expect(cba).toContain("base_order + pg_catalog.cardinality(incoming_keys) + omitted.position_offset");
    expect(cba).toContain("to service_role");
    expect(cba).not.toMatch(/grant execute on function public\.replace_cba_knowledge_drafts[\s\S]{0,160}to authenticated/i);
  });

  it("stores only owner-private opaque calendar event fields", () => {
    expect(calendar).toContain("force row level security");
    expect(calendar).toContain("steward_id = (select auth.uid())");
    expect(calendar).toContain("provider_event_key ~ '^[0-9a-f]{64}$'");
    expect(calendar).toContain("p_window_end > p_window_start + interval '61 days'");
    expect(calendar).toContain("last_event_import_count = imported_count");
    expect(calendar).toContain("event_start >= p_window_end");
    expect(calendar).toContain("event_end <= p_window_start");
    expect(calendar).not.toContain("event_start < p_window_start - interval '1 day'");
    expect(calendar).toContain("where event.steward_id = p_steward and event.provider = p_provider;");
    expect(calendar).toContain("public.clear_calendar_import_events");
    expect(calendar).toContain("public.mark_calendar_import_error");
    expect(calendar).toContain("last_event_import_error_at = pg_catalog.now()");
    expect(calendar).toContain("'lastImportErrorAt', connection.last_event_import_error_at");
    expect(calendar).toContain("last_event_import_status = 'capacity_exceeded'");
    expect(calendar).toContain("last_event_import_status = 'error'");
    expect(calendar).toContain("coalesce(connection.last_event_import_count, 0)");
    expect(calendar).not.toMatch(/\b(title|summary|attendee|location|description)\s+(text|jsonb)/i);
    expect(calendar).not.toMatch(/grant (select|insert|update|delete).*member_calendar_import_events.*authenticated/i);
  });

  it("keeps both provider activations unset with no seeded tenant or credential", () => {
    expect(`${cba}\n${calendar}`).not.toMatch(/insert into public\.(organizations|organization_memberships|chapters)/i);
    expect(`${cba}\n${calendar}`).not.toMatch(/client_secret|refresh_token\s*=/i);
    expect(parity).toContain("coverage = 'activation-unset'");
    expect(parity).toContain("where function_id in ('CR-069', 'CR-090')");
  });

  it("returns the complete authorized knowledge corpus from one statement snapshot", () => {
    expect(knowledgeSnapshot).toContain("public.list_accessible_knowledge_articles_snapshot");
    expect(knowledgeSnapshot).toContain("pg_catalog.jsonb_agg");
    expect(knowledgeSnapshot).toContain("order by article.order_index, article.id");
    expect(knowledgeSnapshot).toContain("not coalesce(p_published_only, false)");
    expect(knowledgeSnapshot).toContain("article.status = 'published'");
    expect(knowledgeSnapshot).toContain("language sql");
    expect(knowledgeSnapshot).toContain("security invoker");
    expect(knowledgeChapterScope).toContain("p_chapter_id text default null");
    expect(knowledgeChapterScope).toContain("security definer");
    expect(knowledgeChapterScope).toContain("private.mi1_knowledge_collection_staff(org)");
    expect(knowledgeChapterScope).toContain("private.mi1_w2_same_org_chapter(org, target_chapter)");
    expect(knowledgeChapterScope).toContain("requested_chapter is distinct from home_chapter");
    expect(knowledgeChapterScope).toContain("pg_catalog.jsonb_agg");
    expect(knowledgeChapterScope).toContain("order by article.order_index, article.id");
    expect(knowledgeChapterScope).toContain("article.chapter_id = target_chapter");
    expect(knowledgeChapterScope).toContain("article.status = 'published'");
    expect(knowledgeChapterScope).toContain("public.save_chapter_kb_article");
    expect(knowledgeChapterScope).toContain("public.retire_chapter_kb_article");
    expect(knowledgeChapterScope).toContain("to authenticated");
    expect(knowledgeChapterScope).not.toMatch(/grant execute[\s\S]{0,180}to (public|anon|service_role)/i);
    expect(knowledgeCollectionScope).toContain("public.list_knowledge_collections");
    expect(knowledgeCollectionScope).toContain("public.save_knowledge_collection");
    expect(knowledgeCollectionScope).toContain("public.set_knowledge_collection_item");
    expect(knowledgeCollectionScope).toContain("public.delete_knowledge_collection");
    expect(knowledgeCollectionScope).toContain("p_chapter_id text default null");
    expect(knowledgeCollectionScope).toContain("count(distinct membership.organization_id) = 1");
    expect(knowledgeCollectionScope).toContain("p_organization_id is distinct from (select private.current_mobile_staff_organization())");
    expect(knowledgeCollectionScope).toContain("p_organization_id is distinct from private.mi1_w2_selected_organization()");
    for (const helper of ["insert", "read", "delete"]) {
      expect(knowledgeCollectionScope).toContain(
        `private.can_${helper}_organization_knowledge_object`,
      );
    }
    expect(knowledgeCollectionScope).toContain("private.current_mobile_staff_organization() is null then false");
    expect(knowledgeCollectionScope).toContain("file.organization_id = private.current_mobile_staff_organization()");
    expect(knowledgeCollectionScope).toContain("private.mi1_knowledge_context_organization(requested_chapter)");
    expect(knowledgeCollectionScope).toContain("private.mi1_w2_same_org_chapter(org, requested_chapter)");
    expect(knowledgeCollectionScope).toContain("article.chapter_id = chapter");
    expect(knowledgeCollectionScope).toContain("return public.list_knowledge_collections(chapter)");
    expect(knowledgeCollectionScope).toContain("public.list_knowledge_review_articles_snapshot");
    expect(knowledgeCollectionScope).toContain("pg_catalog.jsonb_agg");
    expect(knowledgeCollectionScope).toContain("order by article.order_index, article.id");
    expect(knowledgeCollectionScope).toContain("drop function if exists public.list_knowledge_review_articles_page(text, integer, uuid)");
    expect(knowledgeCollectionScope).toContain("to authenticated");
    expect(knowledgeCollectionScope).not.toMatch(/grant execute[\s\S]{0,180}to (public|anon|service_role)/i);
  });

  it("establishes selected-chapter collections and a statement snapshot before the chapterless hardening", () => {
    expect(knowledgeCollectionBase).toContain("drop function if exists public.list_knowledge_review_articles_page");
    expect(knowledgeCollectionBase).toContain("public.list_knowledge_review_articles_snapshot");
    expect(knowledgeCollectionBase).toContain("pg_catalog.jsonb_agg");
    expect(knowledgeCollectionBase).toContain("order by article.order_index, article.id");
    expect(knowledgeCollectionBase).toContain("article.chapter_id = target_chapter");
    expect(knowledgeCollectionBase).not.toContain("p_cursor_order_index");
    for (const name of [
      "list_knowledge_collections",
      "save_knowledge_collection",
      "set_knowledge_collection_item",
      "delete_knowledge_collection",
    ]) {
      expect(knowledgeCollectionBase).toContain(`public.${name}`);
    }
    expect(knowledgeCollectionBase).toContain("p_chapter_id text default null");
    expect(knowledgeCollectionBase).toContain("private.mi1_w2_same_org_chapter(org, target_chapter)");
    expect(knowledgeCollectionBase).toContain("article.chapter_id = target_chapter");
    expect(knowledgeCollectionBase).toContain("return public.list_knowledge_collections(target_chapter)");
    expect(knowledgeCollectionBase).toContain("to authenticated");
    expect(knowledgeCollectionBase).not.toMatch(/grant execute[\s\S]{0,180}to (public|anon|service_role)/i);
  });
});
