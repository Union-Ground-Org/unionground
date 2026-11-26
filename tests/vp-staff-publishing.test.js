import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { STAFF_TOOL_ROLES } from "../src/lib/staffPlanes.js";

const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/20260808033000_vp_staff_publishing.sql");
const readMigration = read("supabase/migrations/20260808040000_vp_draft_documents_read.sql");
const contract = JSON.parse(read("scripts/db-contract.json"));

// REQ-UNION-BASE-PRESIDENT-STAFF-PUBLISHING-RLS-20260807: the owner chose to
// GRANT vp publishing rather than hide the controls, so the contract this
// suite pins is "the UI role gate and the database role gate name the same
// five roles". A migration that drops vp from any of the six policies — or a
// staffPlanes edit that changes the plane list — must land here first.
const FIVE_ROLES = "array['steward','coordinator','advisor','admin','vp']";
const TABLES = ["chapter_spaces", "chapter_documents", "chapter_records"];
const DIRECT_POLICY_TABLES = ["chapter_spaces", "chapter_documents"];

describe("vp staff publishing RLS", () => {
  it("adds vp to the insert policy of all three publishing tables", () => {
    for (const table of TABLES) {
      expect(migration).toMatch(new RegExp(
        `alter policy ${table}_staff_create on public\\.${table}\\s+`
        + `with check \\(chapter_id = private\\.current_member_chapter\\(\\) and created_by = \\(select auth\\.uid\\(\\)\\) and public\\.member_has_role\\(array\\['steward','coordinator','advisor','admin','vp'\\]\\)\\);`,
      ));
    }
  });

  it("adds vp to both halves of the update policy of all three tables", () => {
    for (const table of TABLES) {
      expect(migration).toMatch(new RegExp(
        `alter policy ${table}_staff_write on public\\.${table}\\s+`
        + `using \\(chapter_id = private\\.current_member_chapter\\(\\) and public\\.member_has_role\\(array\\['steward','coordinator','advisor','admin','vp'\\]\\)\\)\\s+`
        + `with check \\(chapter_id = private\\.current_member_chapter\\(\\) and public\\.member_has_role\\(array\\['steward','coordinator','advisor','admin','vp'\\]\\)\\);`,
      ));
    }
  });

  it("carries no role array other than the five-role one", () => {
    // A partial regrant (say, vp on inserts but a four-role update) would pass
    // the per-policy checks above only if it also kept a stray narrower array
    // somewhere; this closes that hole.
    const arrays = migration.match(/array\['[^\]]*'\]/g) || [];
    expect(arrays.length).toBe(9); // 3 create with-checks + 3 write usings + 3 write with-checks
    for (const found of arrays) expect(found).toBe(FIVE_ROLES);
  });

  it("gives vp the staff draft branch of the documents read policy", () => {
    // Vp could
    // write documents but read only published ones, and memberApi writes end
    // in `.select().single()`, so a President saving a draft would have the
    // insert succeed and the returning select refused.
    expect(readMigration).toMatch(new RegExp(
      "alter policy chapter_documents_read on public\\.chapter_documents\\s+using \\(\\s+"
      + "chapter_id = private\\.current_member_chapter\\(\\)\\s+and \\(\\s+"
      + "\\(status = 'published' and \\(visibility = 'chapter' or public\\.member_has_role\\(array\\['steward','coordinator','advisor','admin','vp'\\]\\)\\)\\)\\s+"
      + "or public\\.member_has_role\\(array\\['steward','coordinator','advisor','admin','vp'\\]\\)",
    ));
  });

  it("pins the live five-role expressions in the db contract", () => {
    // The migration-text pins above stop a silent edit to THESE files, but a
    // later migration could still alter a policy back to four roles with every
    // source pin green. scripts/db-contract.json is verified against the LIVE
    // database by verify:db in CI, so these entries are the durable final-state
    // pin: if vp ever leaves a policy in production, CI goes red.
    const LIVE_ROLE_ARRAY = "ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]";
    const byKey = new Map(contract.policies.map((entry) => [`${entry.table}.${entry.name}`, entry]));
    for (const table of DIRECT_POLICY_TABLES) {
      const create = byKey.get(`${table}.${table}_staff_create`);
      const createWithCheckContract = create?.withCheck ? [create.withCheck] : create?.withCheckContains;
      expect(createWithCheckContract).toContainEqual(
        expect.stringContaining(LIVE_ROLE_ARRAY),
      );
      const write = byKey.get(`${table}.${table}_staff_write`);
      const writeQualContract = write?.qual ? [write.qual] : write?.qualContains;
      expect(writeQualContract).toContainEqual(expect.stringContaining(LIVE_ROLE_ARRAY));
      const writeWithCheckContract = write?.withCheck ? [write.withCheck] : write?.withCheckContains;
      expect(writeWithCheckContract).toContainEqual(expect.stringContaining(LIVE_ROLE_ARRAY));
    }
    const institutionalContext = contract.functions.find((entry) => entry.sig === "private.institutional_context(p_require_staff boolean)");
    //  keeps the five-role entry gate and admits scoped staff; member rows have their own oracle.
    expect(institutionalContext?.bodyContains).toContain("private.member_has_chapter_staff_grant(chapter,array['steward','coordinator','advisor','admin','vp'])");
    expect(contract.policiesForbidden).toContainEqual(expect.objectContaining({
      table: "chapter_records",
      namePattern: "chapter_records_staff_(create|write)$",
    }));
    const docsRead = byKey.get("chapter_documents.chapter_documents_read");
    // Exact qual: both the published branch and the staff-draft branch carry vp.
    //  (20261102005607) tests the five roles in the document's own chapter;
    //  (20261109060229) admits unit- and committee-scoped staff through the staff-grant helper.
    expect(docsRead?.qual?.split(`private.member_has_chapter_staff_grant(chapter_id, ${LIVE_ROLE_ARRAY})`).length - 1).toBe(2);
  });

  it("matches the UI gate role-for-role", () => {
    // ProductHubView gates the publishing controls on STAFF_TOOL_ROLES; the
    // database now allows exactly that list. Neither side may drift alone.
    expect(STAFF_TOOL_ROLES).toEqual(["steward", "coordinator", "advisor", "admin", "vp"]);
    expect(FIVE_ROLES).toBe(`array[${STAFF_TOOL_ROLES.map((role) => `'${role}'`).join(",")}]`);
  });
});
