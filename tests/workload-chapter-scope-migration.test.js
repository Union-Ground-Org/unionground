import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("workload_stats_chapter_scope");
const body = stripComments(fnBody(sql, "get_workload_stats"));
const contract = JSON.parse(readFileSync(resolve(process.cwd(), "scripts/db-contract.json"), "utf8"));

describe("get_workload_stats chapter scope", () => {
  it("resolves the authenticated caller's chapter before reading workload rows", () => {
    expect(body).toMatch(/select\s+p\.chapter_id\s+into\s+caller_chapter[\s\S]*from\s+public\.member_profiles\s+p[\s\S]*where\s+p\.id\s*=\s*caller/);
    expect(body).toContain("if caller_chapter is null then");
  });

  it("chapter-restricts both the anonymity count and aggregate source", () => {
    const predicates = body.match(/p\.chapter_id\s*=\s*caller_chapter/g) || [];
    expect(predicates).toHaveLength(2);

    const profileJoins = body.match(/join\s+public\.member_profiles\s+p\s+on\s+p\.id\s*=\s+l\.user_id/g) || [];
    expect(profileJoins).toHaveLength(2);
  });

  it("preserves the anonymity floor and authenticated-only grant", () => {
    expect(body).toContain("K constant integer := 25");
    expect(body).toContain("if caller is null then");
    expect(stripComments(sql)).toMatch(/grant execute on function public\.get_workload_stats\(\) to authenticated/);
  });

  it("makes chapter scope a live-database contract", () => {
    const entry = contract.functions.find((item) => item.sig === "public.get_workload_stats()");
    expect(entry?.bodyContains).toEqual(expect.arrayContaining([
      "caller_chapter text := private.current_member_chapter()",
      "join public.member_profiles p on p.id = w.user_id",
      "where p.chapter_id = caller_chapter",
    ]));
  });
});
