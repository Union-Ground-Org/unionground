// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadMigrationSql } from "./helpers/migration.js";

// Offline pins for the receipt-reader census that 20260906028000 records in its
// header.
//
// WHY THIS FILE EXISTS. The round-2 review of PR #1609 required an audit of
// "every other receipt reader that could return knowledge content". The first
// draft of that audit was produced by scanning migration files and undercounted
// the readers (it attributed a receipt read inside set_case_restriction to the
// function defined above it); independent verification enumerated them from the
// live catalog instead and found seven. The census is now stated from the
// catalog, and this file keeps the undercount from ever being restored as the
// current answer. (The security document that repeated the census is not part
// of Union Ground.)
const NAME = "20260906028000_knowledge_revision_provenance";
const sql = loadMigrationSql(NAME);
const READERS = [
  "public.prepare_steward_library_upload",
  "public.complete_steward_library_upload",
  "public.publish_steward_file_to_catalog",
  "public.restore_chapter_kb_revision",
  "public.clear_knowledge_ingest_source_chunks",
  "public.retry_knowledge_ingest_source",
  "public.set_case_restriction",
];

const squash = (text) => text.replace(/\s+/g, " ").trim();
// Header prose is line-prefixed with "--"; drop the markers before squashing so
// a value that wraps across comment lines reads as one string.
const prose = (text) => squash(text.replace(/^--\s?/gm, ""));

describe("knowledge receipt reader census", () => {
  it("names all seven authenticated readers in the migration header, enumerated from the catalog", () => {
    const header = sql.slice(0, sql.indexOf("set local lock_timeout"));
    expect(header).toContain("AUDIT OF EVERY OTHER RECEIPT READER THAT COULD RETURN KNOWLEDGE CONTENT.");
    expect(prose(header)).toContain("exactly seven functions read the receipt table in their own body");
    expect(prose(header)).toContain("Enumerated from the live catalog");
    for (const reader of READERS) {
      expect(header, `${reader} must be named in the census`).toContain(reader);
    }
    // The undercount may never come back as the current answer.
    expect(header).not.toMatch(/exactly four/i);
  });

  it("states why each non-article reader is out of scope, from its cached projection", () => {
    const header = prose(sql.slice(0, sql.indexOf("set local lock_timeout")));
    expect(header).toContain("{id, fileId, kind, label, chunkCount, embeddedCount, health, lastIngestAt, lastError}");
    expect(header).toContain("public.set_case_restriction caches only {caseId, restricted}");
    expect(header).toContain("private.mi1_w2_project_knowledge_file's projection");
    expect(header).toContain("is the ONLY reader that can return knowledge ARTICLE content");
    expect(header).toContain("private.member_operations_replay and private.member_operations_store_receipt are revoked from public, anon, authenticated and service_role");
  });
});
