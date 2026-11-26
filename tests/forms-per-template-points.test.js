// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not what the database ENDS UP WITH. A later create-or-replace can supersede
// every guard below and this file stays green. Current-state truth lives in
// scripts/db-contract.json, checked by `npm run verify:db`.
//
// Superseded here: private.form_points, whose hardcoded CASE
// 20260724111000_form_templates_lookup_rewrite replaced with a form_templates
// read (the three tests that pinned it were deleted), and private.award_member_
// points, redefined twice more after this migration.

const sql = loadMigrationSql("per_template_points");
// award_member_points closes on $function$, form_points on $$; fnBody stops at
// whichever terminator comes first, so both read correctly here.
const body = (functionName) => fnBody(sql, functionName);

// DELETED: describe("private.form_points mapping") — three tests that pinned the
// hardcoded CASE inside private.form_points(text). 20260724111000_form_templates_
// lookup_rewrite replaced that CASE with a read of public.form_templates, so all
// three asserted a superseded body and could never fail. The seven point values
// they protected are still pinned, against the registry that now owns them, by
// form-templates-registry.test.js ("seeds the live per-template point values"),
// and the live function's shape is in scripts/db-contract.json.

describe("award_member_points per-template form award", () => {
  const trigger = body("private.award_member_points");

  it("defaults the award to the per-kind rule and overrides only for forms", () => {
    expect(trigger).toContain("award_points := rule.points;");
    expect(trigger).toContain("award_points := private.form_points(v_template);");
    // the ledger insert must use the (possibly overridden) award_points, never
    // the flat rule.points again
    expect(trigger).toMatch(/values \(new\.user_id, new\.action_key, new\.action_kind, award_points\)/);
    expect(trigger, "the insert must not hard-code rule.points anymore").not.toMatch(
      /action_kind, rule\.points\)/
    );
  });

  it("keeps the form branch prefix-anchored and backed by a non-draft owned form", () => {
    expect(trigger).toContain("pg_catalog.left(new.action_key, 5) = 'form-'");
    expect(trigger).toContain("status <> 'draft'");
  });

  it("preserves every other backed point kind (no branch dropped in the reproduction)", () => {
    for (const kind of ["vote", "survey", "rights", "case", "message", "steward", "rsvp", "checkin", "workload"]) {
      expect(trigger, `${kind} branch must survive`).toContain(`new.action_kind = '${kind}'`);
    }
    // untouched invariants
    expect(trigger).toContain("if new.action_kind = 'seed' then");
    expect(trigger).toContain("on conflict (user_id, action_key) do nothing");
    expect(trigger).toContain("awarded_this_week >= rule.weekly_cap");
  });
});
