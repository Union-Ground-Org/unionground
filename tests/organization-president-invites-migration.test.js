// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

// REQ-UG-INVITE-RIGHTS-AND-ACCESS-REQUESTS-20261030 (#6561, Oct 29-30
// swarm finding 26, MAIN ruling Oct 30, 2026): an organization-wide President
// invites plain members with the same form and limits as a chapter President.
const sql = loadMigrationSql("20261030233000_organization_president_invites");
const presided = stripComments(fnBody(sql, "private.member_invitation_chapter_presided(p_chapter_id text)"));

describe("organization-wide President invitations", () => {
  it("is one atomic migration that only redefines the presiding check", () => {
    const code = stripComments(sql);
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    expect(code.match(/create or replace function/gu)).toHaveLength(1);
    expect(code).toContain("revoke all on function private.member_invitation_chapter_presided(text)\n  from public, anon, authenticated, service_role;");
    expect(code).not.toMatch(/grant execute/iu);
  });

  it("keeps the chapter President and adds an organization-wide vp grant in the caller's own organization", () => {
    expect(presided).toContain("private.member_has_chapter_role(p_chapter_id, array['vp'])");
    expect(presided).toContain("rc.user_id = p.id and rc.chapter_id = target.id and rc.role = 'vp'");
    expect(presided).toContain("private.has_organization_role(target.organization_id, array['vp'])");
    // Both branches stay bound to the organization of the selected chapter.
    expect(presided.match(/target\.organization_id = selected\.organization_id/gu)).toHaveLength(2);
    expect(presided.match(/selected\.organization_id is not null/gu)).toHaveLength(2);
    // Never an admin grant, never a starting-access path.
    expect(presided).not.toMatch(/'admin'|initial_role/u);
  });
});
