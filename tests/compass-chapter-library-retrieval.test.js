// @vitest-environment node
// UB-RGT-02 — text tripwires over the migration that teaches Compass retrieval
// about the chapter library.
//
// The live catalog truth is verify:db's job. These pin what the SQL SAYS, so a
// regression in the file is caught offline before any database sees it. Three
// of them guard properties that fail SILENTLY in production rather than loudly:
//
//   * published-only. If the filter is dropped, retrieval still "works" and the
//     tests still pass — but Compass starts quoting half-written drafts back to
//     members as settled chapter policy, and nothing surfaces it.
//   * security invoker. Flipping to definer also still "works": every member
//     simply starts getting cited documents from other chapters and the
//     staff-visibility tier. A cross-chapter leak with no error.
//   * no decorative GIN index. PostgreSQL treats `@@` as non-leakproof, so an
//     authenticated invoker query cannot push the term through the table's RLS
//     barrier into an Index Cond. The chapter/status btree safely narrows first;
//     a future GIN attempt needs a separately reviewed scoped boundary.
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

// 20260906024000 is the live definer: it re-issues search_member_kb with the
// storage-derived provenance conjunct that binds an imported clause to the
// ledger verdict of the organization-knowledge object it was extracted from.
// Every property pinned below survived that change unaltered.
const FINAL_FRAGMENT = "knowledge_source_verdict_gates";
const sql = stripComments(loadMigrationSql(FINAL_FRAGMENT));
const body = fnBody(sql, "public.search_member_kb");

const squash = (text) => text.replace(/\s+/g, " ").trim();

describe("compass chapter library retrieval migration", () => {
  it("supersedes every earlier search_member_kb definition", () => {
    const definers = migrationNames().filter((name) => {
      try {
        return Boolean(fnBody(loadMigrationSql(name), "public.search_member_kb"));
      } catch {
        return false;
      }
    });
    expect(definers.length).toBeGreaterThan(1);
    // Migrations apply in filename order, so the last definer is the live one.
    // This file pins the CHAPTER-LIBRARY branch of the union, which no later
    // migration has touched; the article branch's provenance conjunct has moved
    // through source provenance and ingestion classification, so the live definer
    // is named here explicitly rather than assumed to be this file's own.
    expect(definers.at(-1)).toBe("20261003065000_compass_scope_path_resolver.sql");
    // ...and this file's own definition is still in the lineage, so the pins
    // below describe a real ancestor rather than a file nothing applies.
    expect(definers.some((name) => name.includes(FINAL_FRAGMENT))).toBe(true);
  });

  it("searches chapter_documents and cites them as chapter library sources", () => {
    expect(body).toContain("from public.chapter_documents d");
    expect(squash(body)).toContain("'doc:' || d.id::text");
    expect(squash(body)).toContain("'Chapter library · ' || d.document_type");
    expect(squash(body)).toContain("coalesce(d.title, '') || ' ' || coalesce(d.document_type, '')");
    expect(squash(body)).toContain(") @@ (select ts from q)");
  });

  it("keeps published knowledge and rights sources while excluding private cases", () => {
    expect(body).toContain("from public.member_kb_articles a");
    expect(body).toContain("from public.member_rights_lessons l");
    expect(body).not.toContain("from public.member_cases c");
  });

  it("binds storage-derived imported clauses to the originating file's ledger verdict", () => {
    // A CBA clause carries knowledge_source_id provenance back to an
    // organization-knowledge object. Without this conjunct a source that went
    // stale, failed, blocked or deleted kept grounding Compass answers with
    // text nothing vouches for. The conjunct sits on the member_kb_articles
    // branch ONLY: rights lessons and chapter documents have no Storage
    // provenance and must keep the semantics they already had.
    expect(squash(body)).toContain("and private.knowledge_source_verdict_current(a.knowledge_source_id)");
    expect(body).not.toContain("knowledge_source_verdict_current(l.");
    expect(body).not.toContain("knowledge_source_verdict_current(d.");
  });

  it("cites published documents only, never drafts or archived ones", () => {
    expect(squash(body)).toContain("and d.status = 'published'");
  });

  it("keeps RLS authoritative while adding an equivalent indexable chapter bound", () => {
    // security invoker keeps chapter_documents_read authoritative. The
    // explicit equivalent predicate lets the chapter/status btree narrow the
    // candidate set before ranking at production scale.
    expect(squash(body)).toContain("security invoker");
    expect(body).not.toMatch(/security\s+definer/i);
    expect(squash(body)).toContain("d.chapter_id = private.current_member_chapter()");
  });

  it("prefers the authored summary and falls back to the body", () => {
    expect(squash(body)).toContain("coalesce(nullif(pg_catalog.btrim(d.summary), ''), d.body)");
  });

  it("does not add an unusable GIN index behind the invoker RLS barrier", () => {
    expect(sql).not.toContain("chapter_documents_compass_search_idx");
    expect(sql).not.toMatch(/create\s+index[\s\S]*chapter_documents[\s\S]*using\s+gin/i);
    expect(squash(body)).toContain("and d.status = 'published'");
  });

  it("keeps the retrieval result capped the way the caller expects", () => {
    // api/guide.js slices to 6 and asks for 4; the function must not out-run it.
    expect(squash(body)).toContain("least(greatest(coalesce(p_limit, 4), 1), 6) as lim");
    expect(squash(body)).toContain("limit (select lim from q)");
  });
});
