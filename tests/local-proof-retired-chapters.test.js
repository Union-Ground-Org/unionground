// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { loadMigrationSql } from "./helpers/migration.js";

// TEST-UG-LOCAL-FORM-FILING-CONCURRENCY-PROOF-CANNOT-RUN-20261114
// (#8732): a local proof that seeds into a chapter the migrations retired
// stops at its first fixture write (23503 on member_profiles) and proves
// nothing. No CI job runs these scripts, so this static check is what notices.
const PROOFS_THAT_OWN_THEIR_CHAPTER = Object.freeze([
  "scripts/verify-form-filing-concurrency-local.mjs",
]);

function retiredChapterIds() {
  const sql = loadMigrationSql("retire_legacy_agency_chapters");
  const list = sql.match(/chapter_ids\s+constant\s+text\[\]\s*:=\s*array\[([^\]]+)\]/)?.[1];
  if (!list) throw new Error("The retired chapter list moved; update this test");
  return [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe("local proofs seed only chapters that exist", () => {
  const retired = retiredChapterIds();

  it("reads the retired chapter list from its migration", () => {
    expect(retired).toEqual(expect.arrayContaining(["wor", "bos", "dcf-wor"]));
  });

  it.each(PROOFS_THAT_OWN_THEIR_CHAPTER)("%s names no retired chapter", (path) => {
    const source = readFileSync(path, "utf8");
    const named = retired.filter((id) => source.includes(`'${id}'`) || source.includes(`"${id}"`));
    expect(named).toEqual([]);
  });
});
