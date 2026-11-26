// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not what the database ENDS UP WITH. A later create-or-replace can supersede
// every guard below and this file stays green. Current-state truth lives in
// scripts/db-contract.json, checked by `npm run verify:db`.
//
// Superseded here: open_form_as_case, redefined again by 20260723112000_member_
// forms_template_registry_fk. The no-existence-oracle property this file pins is
// a property of the body it reads, not of the function in the database.

const sql = loadMigrationSql("no_existence_oracle");
const body = (functionName) => fnBody(sql, functionName);

describe("open_form_as_case closes the existence oracle", () => {
  it("collapses another member's private (draft/returned) form into the generic not-found", () => {
    const open = body("public.open_form_as_case");
    // One generic guard must cover missing rows, the caller's own form, AND the
    // two member-private states — a steward can never legitimately see a draft
    // or returned form, so a status-specific message would be an existence
    // oracle for it.
    expect(open).toMatch(
      /if not found or rec\.user_id = caller or rec\.status in \('draft', 'returned'\) then/
    );
    const generic = open.indexOf("form not found or your own");
    const statusSpecific = open.indexOf("only approved forms can be opened as cases");
    expect(generic).toBeGreaterThan(-1);
    expect(statusSpecific).toBeGreaterThan(-1);
    // the generic guard must fire BEFORE any status-specific raise leaks
    expect(generic).toBeLessThan(statusSpecific);
  });

  it("preserves every PR2 security invariant (role gate, self-review, server uuid ref, no minting)", () => {
    const open = body("public.open_form_as_case");
    expect(open, "role gate").toContain("member_has_role(array['steward'])");
    expect(open, "self-review guard").toContain("rec.user_id = caller");
    expect(open, "server-generated reference").toContain("extensions.gen_random_uuid()");
    expect(open, "reference must not derive from the member-visible form id").not.toContain("rec.id::text");
    expect(open, "steward RPCs never mint points").not.toContain("member_action_log");
  });
});
