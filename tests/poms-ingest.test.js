// @vitest-environment node
// REQ-UG-POMS-FUNCTION-REMOVAL-20261003. Owner decision, October 3, 2026:
// "yes delete it all. everything poms needs to go." This file used to test the
// POMS ingestion function; it now keeps that function gone. It fails if a later
// change brings back the route, the page, the client wrappers, the copy or a
// database object.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REMOVAL_MIGRATION = "20261003070000_poms_function_removal.sql";
const RETIRED_FILES = ["api/poms-ingest.js", "api/_lib/pomsIngest.js"];

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return /\.(?:jsx?|tsx?|mjs|css)$/.test(name) ? [path] : [];
  });
}

describe("retired POMS function", () => {
  it("has no API entry or helper file left", () => {
    for (const path of RETIRED_FILES) expect(existsSync(path), path).toBe(false);
  });

  it("has no function entry, route, page, client wrapper or copy left", () => {
    expect(readFileSync("vercel.json", "utf8")).not.toMatch(/poms/i);
    const offenders = [...sourceFiles("src"), ...sourceFiles("api"), ...sourceFiles("apps/mobile/src"), ...sourceFiles("apps/mobile/app")]
      .filter((path) => /poms/i.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
    const pages = readFileSync("src/lib/workspacePages.js", "utf8");
    expect(pages).toContain('tabs: ["notes", "actions"]');
  });

  it("drops every POMS table and RPC and adds none back later", () => {
    const migrations = readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort();
    expect(migrations).toContain(REMOVAL_MIGRATION);
    const removal = readFileSync(join("supabase/migrations", REMOVAL_MIGRATION), "utf8");
    for (const table of ["organization_poms_evidence", "organization_poms_ingest_chunks", "organization_poms_sources"]) {
      expect(removal).toMatch(new RegExp(`^drop table public\\.${table};$`, "m"));
    }
    for (const rpc of ["save_poms_source", "update_poms_source", "authorize_poms_ingestion", "complete_poms_ingestion",
      "reconcile_poms_ingestion_completion", "add_poms_evidence"]) {
      expect(removal).toMatch(new RegExp(`^drop function public\\.${rpc}\\(`, "m"));
    }
    expect(removal).toContain("delete from public.organization_object_action_runs where target_kind = 'poms_source';");
    const later = migrations.filter((name) => name > REMOVAL_MIGRATION);
    for (const name of later) {
      expect(readFileSync(join("supabase/migrations", name), "utf8"), name).not.toMatch(/poms/i);
    }
  });
});
