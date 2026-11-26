// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

// REQ-UG-INVITATION-SUGGESTIONS-AND-ACCESS-REQUESTS-20261030 (#6634).
const sql = loadMigrationSql("20261030235900_member_requests");
const code = stripComments(sql);
const body = (name) => stripComments(fnBody(sql, name));

describe("member requests migration", () => {
  it("keeps the table behind its definers, with the MFA floor and a self-only read", () => {
    expect(code).toContain("revoke all on public.member_requests from public, anon, authenticated, service_role;");
    expect(code).toContain("create policy mfa_assurance on public.member_requests\n  as restrictive for all to authenticated");
    expect(code).toContain("using ((select auth.uid()) = requester_user_id);");
    expect(code).toContain("for each row execute function private.lock_case_graph_row_keys('{decided_by},{requester_user_id}', '');");
    for (const fn of ["public.submit_member_request(text, text, text, text, text)", "public.list_my_member_requests(integer, timestamptz, uuid)", "public.list_member_requests(text, integer, timestamptz, uuid)", "public.decide_member_request(uuid, text)"]) {
      expect(code).toContain(`revoke all on function ${fn} from public, anon;`);
      expect(code).toContain(`grant execute on function ${fn} to authenticated;`);
    }
    expect(code).not.toMatch(/grant[^;]*\bto\b[^;]*\banon\b/iu);
  });

  it("bounds submissions and never asks whether an address has an account", () => {
    const submit = body("public.submit_member_request");
    expect(submit).toContain("request limit reached");
    expect(submit).toContain("'member-request:' || caller::text");
    expect(submit).not.toMatch(/auth\.users|member_invitations/u);
    expect(submit).toContain("on conflict do nothing");
  });

  it("lets only those who may invite or grant decide, and grants through the existing writer", () => {
    const decidable = body("private.member_request_decidable");
    expect(decidable).toContain("private.member_invitation_chapter_administrable(p_chapter_id)");
    expect(decidable).toContain("private.member_invitation_chapter_presided(p_chapter_id)");
    expect(decidable).toContain("private.has_organization_role(p_organization_id, array['admin'])");
    const decide = body("public.decide_member_request");
    expect(decide.indexOf("private.member_request_decidable(found_row.kind")).toBeLessThan(decide.indexOf("perform public.set_member_chapter_role("));
    expect(decide).toContain("for update");
    expect(body("public.list_member_requests")).toContain("private.member_request_decidable(r.kind, r.organization_id, r.chapter_id)");
  });

  it("registers the account lifecycle and notification copy in both languages", () => {
    expect(code).toContain("('public', 'member_requests', 'requester_user_id', 'cascade'");
    expect(code).toContain("('public', 'member_requests', 'decided_by', 'not_applicable'");
    for (const key of ["requests.invitation_suggested", "requests.access_requested", "requests.suggestion.approved", "requests.suggestion.declined", "requests.access.approved", "requests.access.declined"]) {
      expect(code).toContain(`('${key}', 'en',`);
      expect(code).toContain(`('${key}', 'es',`);
    }
  });
});
