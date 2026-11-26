import fs from "node:fs";
import { describe, expect, it } from "vitest";

const sql = fs.readFileSync("supabase/migrations/20260810184500_admin_governance_closeout.sql", "utf8").toLowerCase();

describe("admin governance close-out", () => {
  it("requires MFA and the admin role for both RPCs", () => {
    expect(sql.match(/private\.mfa_satisfied\(\)/g)).toHaveLength(2);
    expect(sql.match(/member_has_role\(array\['admin'\]\)/g)).toHaveLength(2);
  });

  it("hard-scopes reads and writes to the caller chapter and derives the handler", () => {
    expect(sql).toContain("where r.chapter_id = caller_chapter");
    expect(sql).toContain("r.chapter_id = private.current_member_chapter()");
    expect(sql).toContain("handled_by = caller");
  });

  it("allows only named admin statuses with a bounded written response", () => {
    expect(sql).toContain("p_status not in ('reviewing', 'fulfilled', 'denied')");
    expect(sql).toContain("not between 1 and 10000");
    expect(sql).toContain("btrim(p_response)");
  });
});
