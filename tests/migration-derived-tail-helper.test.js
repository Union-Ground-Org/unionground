// @vitest-environment node
import { describe, expect, it } from "vitest";
import { migrationObjects, sqlObjectsNamed } from "./helpers/migration.js";
import { PROVENANCE_MIGRATIONS, provenanceObjects } from "./helpers/knowledge-provenance.js";

// The derived tail check in the three knowledge provenance pins is only as
// strong as the classifier behind it, so the classifier is pinned here.
describe("derived migration tail classifier", () => {
  const objects = ["public.save_chapter_kb_article", "public.member_kb_articles", "private.knowledge_article_content_current"];

  it("reports a later migration that re-emits, alters, grants or reads a described object", () => {
    expect(sqlObjectsNamed("create or replace function public.save_chapter_kb_article(p uuid) returns void language sql as $$ select 1 $$;", objects))
      .toEqual(["public.save_chapter_kb_article"]);
    expect(sqlObjectsNamed('alter table "public"."member_kb_articles" add column x int;', objects)).toEqual(["public.member_kb_articles"]);
    expect(sqlObjectsNamed("revoke execute on function save_chapter_kb_article(uuid) from anon;", objects)).toEqual(["public.save_chapter_kb_article"]);
    expect(sqlObjectsNamed("create policy p on public.member_kb_articles for select using (true);", objects)).toEqual(["public.member_kb_articles"]);
    expect(sqlObjectsNamed("select private.knowledge_article_content_current(a) from t a;", objects)).toEqual(["private.knowledge_article_content_current"]);
  });

  it("reports a schema-wide statement that could touch a described object without naming it", () => {
    expect(sqlObjectsNamed("revoke execute on all functions in schema public from anon;", objects)).toEqual(["<schema-wide statement>"]);
    expect(sqlObjectsNamed("alter default privileges in schema public grant select on tables to anon;", objects)).toEqual(["<schema-wide statement>"]);
  });

  it("ignores comments, longer identifiers and unrelated objects", () => {
    expect(sqlObjectsNamed("-- public.member_kb_articles is not touched here\n/* save_chapter_kb_article */ select 1;", objects)).toEqual([]);
    expect(sqlObjectsNamed("create table public.member_kb_articles_archive (id uuid);", objects)).toEqual([]);
    expect(sqlObjectsNamed("select public.save_chapter_kb_article_v2();", objects)).toEqual([]);
    expect(sqlObjectsNamed("create or replace function public.chapter_task_report() returns int language sql as $$ select 1 $$;", objects)).toEqual([]);
  });

  it("reads a real object set out of the three provenance migrations", () => {
    expect(PROVENANCE_MIGRATIONS.every((name) => migrationObjects(name).length > 0)).toBe(true);
    for (const object of [
      "public.member_kb_articles",
      "public.member_kb_article_revisions",
      "public.save_chapter_kb_article",
      "public.restore_chapter_kb_revision",
      "public.retire_chapter_kb_article",
      "public.replace_cba_knowledge_drafts",
      "public.list_chapter_kb_revisions",
      "private.knowledge_article_content_current",
    ]) expect(provenanceObjects()).toContain(object);
    // A join alias (`on article.id = ...`) must never be read as an object.
    expect(provenanceObjects().every((object) => /^(public|private|auth|storage)\./.test(object))).toBe(true);
  });
});
