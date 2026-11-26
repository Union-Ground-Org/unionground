import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not what the database ENDS UP WITH. The live-DB backstop for this bound is
// scripts/db-contract.json (a constraints entry), checked by `npm run verify:db`
// against production — a prod-side DROP CONSTRAINT is invisible to a
// migration-file text pin, so both layers are asserted below.
//
// Superseded object: member_rights_progress gains a CHECK bounding
// completed_steps cardinality (REQ-UG-RIGHTS-PROGRESS-BOUNDS-20260725). The
// column is integer[]; every element is a fixed 4 bytes, so cardinality IS the
// total-size bound the acceptance names.

const sql = loadMigrationSql("bound_rights_progress_completed_steps");

// This migration's HEADER quotes the bound expression repeatedly ("<= 64",
// "> 64", "cardinality(completed_steps)"). Every pin below runs on
// comment-stripped code so a comment can never satisfy a load-bearing
// assertion. Same discipline as tests/points-mint-rebind.test.js.
const codeOnly = stripComments(sql);

describe("member_rights_progress.completed_steps carries a bounding CHECK", () => {
  it("adds a CHECK named member_rights_progress_completed_steps_bounded", () => {
    expect(codeOnly).toMatch(/add constraint\s+member_rights_progress_completed_steps_bounded\s+check/);
  });

  it("bounds cardinality at 64 — integer[], so cardinality is the size bound", () => {
    // Boundary-terminated with (?!\d): a bare toContain("<= 64") would also pass
    // on a weakened "<= 640" (64 is a digit-prefix of 640), silently green while
    // the cap loosens 10x. The negative lookahead makes a trailing digit break
    // the match. (Hole caught by adversarial review, 2026-07-25.)
    expect(codeOnly).toMatch(/cardinality\(completed_steps\) <= 64(?!\d)/);
  });

  it("is added VALIDATED, not NOT VALID — the bound must reach existing rows too", () => {
    // NOT VALID would let a pre-existing bloated row live forever while reading
    // identically in the SQL text. There is exactly one constraint added here
    // and it must apply to the whole table, so NOT VALID must not appear at all.
    expect(codeOnly.toLowerCase()).not.toContain("not valid");
  });

  it("validates existing rows BEFORE enforcing, failing loudly on any violator", () => {
    // Acceptance: the constraint is validated against existing rows before it is
    // enforced. The pre-flight DO block counts rows over the bound and raises
    // check_violation with the exact count instead of an opaque constraint error.
    expect(codeOnly).toMatch(/cardinality\(completed_steps\) > 64(?!\d)/);
    expect(codeOnly).toContain("check_violation");
    expect(codeOnly).toMatch(/raise\s+exception/i);
  });
});

describe("the live-DB backstop is wired into the contract", () => {
  const contract = JSON.parse(readFileSync(resolve(process.cwd(), "scripts/db-contract.json"), "utf8"));
  const entry = (contract.constraints || []).find(
    (c) => c.table === "member_rights_progress" && c.name === "member_rights_progress_completed_steps_bounded",
  );

  it("scripts/db-contract.json pins the constraint so verify:db catches a prod-side drop or weakening", () => {
    expect(entry, "a constraints entry for the bound must exist").toBeTruthy();
    // Validated in prod, not NOT VALID — the verifier asserts convalidated too.
    expect(entry.convalidated).toBe(true);
    // BOUNDARY-TERMINATED with the trailing )): the live def renders
    // CHECK ((cardinality(completed_steps) <= 64)), so a weakening to <= 640
    // renders ...<= 640)) which does NOT contain "<= 64))", and an appended
    // no-op ...<= 64) OR true)) drops it too. Any numeric weakening therefore
    // fails verify:db. (A bare "<= 64" substring would have passed on 640 — the
    // hole an adversarial review caught, 2026-07-25.)
    expect(entry.defContains).toContain("cardinality(completed_steps) <= 64))");
  });
});
