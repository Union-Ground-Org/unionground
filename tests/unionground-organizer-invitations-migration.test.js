import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Organizers are campaign staff, so an
// administrator may invite someone as an Organizer.
const sql = readFileSync(path.join(process.cwd(), "supabase/migrations/20261015160000_unionground_organizer_invitations.sql"), "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");

describe("Organizer invitations (D2)", () => {
  it("lets an invitation carry the Organizer hat and never admin", () => {
    expect(code).toContain("check (initial_role is null or initial_role in ('steward', 'organizer', 'coordinator', 'advisor', 'vp'))");
    expect(code).not.toMatch(/initial_role in \([^)]*'admin'/);
  });

  it("patches only the role list of the live create_member_invitation and refuses to run without it", () => {
    expect(code).toContain("pg_catalog.pg_get_functiondef(target)");
    expect(code).toContain("clean_role not in ('steward', 'coordinator', 'advisor', 'vp')");
    expect(code).toContain("clean_role not in ('steward', 'organizer', 'coordinator', 'advisor', 'vp')");
    expect(code).toMatch(/<> 1 then\s+raise exception 'create_member_invitation role list not found exactly once'/);
    expect(code).toContain("execute replace(definition, old_list, new_list);");
  });
});
