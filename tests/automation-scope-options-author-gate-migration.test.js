// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, migrationFiles, migrationNames, stripComments } from "./helpers/migration.js";

// The newest migration that declares `name` (create or replace), raw body.
function latestFunction(name) {
  const declared = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+${name.replace(".", "\\.")}\\s*\\(`, "i");
  const migration = [...migrationFiles()].reverse().find(({ sql }) => declared.test(stripComments(sql)));
  if (!migration) throw new Error(`function ${name} is not declared in any migration`);
  return fnBody(migration.sql, name);
}

const NAME = "public.mi1_get_automation_scope_options";

describe("automation scope options author gate migration", () => {
  it("opens the scope picker to the v3 author gate while keeping every staff-role filter", () => {
    const body = stripComments(latestFunction(NAME));
    expect(body).toContain("private.automation_v3_require_author()");
    expect(body).not.toContain("private.cr108_require_operator()");
    // The page guard, the 80-character search bound and the source enum check
    // are unchanged from the operator-gated original.
    expect(body).toContain("private.automation_v2_page_guard(p_page,p_page_size)");
    expect(body).toContain("length(p_search)>80");
    expect(body).toMatch(/p_source not in \('task','case','appointment','event'\)/);
    // Chapters stay behind the caller's staff-role predicate (existence guard
    // plus chapter query). People keep the original "this person is staff of
    // their chapter" check and also require the caller staffs that chapter.
    expect(body.match(/private\.actor_has_chapter_staff_role\(/g)?.length).toBeGreaterThanOrEqual(6);
    expect(body.match(/private\.actor_has_chapter_staff_role\(auth\.uid\(\),ch\.id\)/g)?.length).toBe(2);
    expect(body.match(/private\.actor_has_chapter_staff_role\(p\.id,ch\.id\)/g)?.length).toBe(2);
    expect(body).toContain("position(lower(p_search) in lower(p.full_name))>0");
    expect(body).not.toContain("m.status='active' and 1=1"); // no filter was weakened to a tautology
  });

  it("lands after the v3 author gate and the operator-gated original both exist", () => {
    const names = migrationNames();
    const authorGateAt = names.findIndex((name) => name.includes("automation_shared_intelligence_v3"));
    const originalAt = names.findIndex((name) => name.includes("connected_automation_v2"));
    const replacement = names.filter((name) => name.includes("automation_scope_options_author_gate"));
    expect(replacement).toHaveLength(1);
    const replacementAt = names.indexOf(replacement[0]);
    expect(authorGateAt).toBeGreaterThan(-1);
    expect(originalAt).toBeGreaterThan(-1);
    expect(replacementAt).toBeGreaterThan(authorGateAt);
    expect(replacementAt).toBeGreaterThan(originalAt);
    // The original operator-gated declaration stays byte-identical in its own
    // file. The replacement re-emits that body with the v3 author gate and the
    // caller staff-role predicate on both people queries; nothing else moves.
    const original = stripComments(loadMigrationSql("connected_automation_v2"));
    expect(original).toContain("declare org uuid:=private.cr108_require_operator();");
    const latest = stripComments(latestFunction(NAME));
    const peopleCaller = "and private.actor_has_chapter_staff_role(auth.uid(),ch.id) ";
    const swapped = latest
      .replace("private.automation_v3_require_author()", "private.cr108_require_operator()")
      .replaceAll(peopleCaller, "");
    const originalBody = original.slice(original.indexOf("create function public.mi1_get_automation_scope_options"));
    expect(latest.split(peopleCaller).length - 1).toBe(2);
    expect(swapped.replace(/\s+/g, " ").replace(/^create or replace /, "create ")).toBe(
      originalBody.slice(0, originalBody.indexOf("$$;") + 3).replace(/\s+/g, " "));
  });

  it("keeps the replacement a single bounded transaction", () => {
    const sql = stripComments(loadMigrationSql("automation_scope_options_author_gate"));
    expect(sql).toMatch(/^\s*begin;/);
    expect(sql).toMatch(/commit;\s*$/);
  });

  it("changes the stored routine body, so the DB contract md5 moves with it", () => {
    const latest = latestFunction(NAME);
    const prosrc = latest.slice(latest.indexOf("$$") + 2, latest.lastIndexOf("$$"));
    expect(createHash("md5").update(prosrc).digest("hex")).toBe("55b174223f651c577223ec8d25f7883a");
  });

  it("retains a disposable-stack steward role-matrix proof for the widened picker", () => {
    const proof = readFileSync("scripts/verify-automation-shared-intelligence-v3-local.mjs", "utf8");
    expect(proof).toContain('rpc("mi1_get_automation_scope_options", ["task", null, "", 1, 6])');
    expect(proof).toContain("automation-v3-visible");
    expect(proof).toContain("automation-v3-hidden");
    expect(proof).toContain("steward_unstaffed_chapter");
    expect(proof).toContain("ids.steward");
  });
});

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;
live("automation scope options author-gate database behavior", () => {
  it("proves a steward sees only staffed chapters and is refused an unstaffed chapter id", () => {
    const databaseUrl = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    const result = execFileSync(process.execPath, ["scripts/verify-automation-shared-intelligence-v3-local.mjs"], {
      encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, SUPABASE_DB_URL: databaseUrl },
    });
    expect(JSON.parse(result.trim())).toMatchObject({ status: "passed" });
  }, 190000);
});
