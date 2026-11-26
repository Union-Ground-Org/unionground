// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("unified_connection_handshakes"));
const request = fnBody(sql, "public.request_chapter_connection_handshake");
describe("one published-connection and chapter-handshake system", () => {
  it("reuses the legacy lifecycle after exact-source, exact-hat and fresh target checks", () => {
    expect(request).toContain("private.mi1_require_selected_organization()");
    expect(request).toContain("private.chapter_connection_require_hat(org, p_selected_hat, chapter");
    expect(request).toContain("chapter is distinct from private.current_member_chapter()");
    expect(request).toContain("private.member_has_chapter_role(chapter, array[p_selected_hat])");
    expect(request).toContain("where p.chapter_id = target");
    expect(request).toContain("b.chapter_id = p.chapter_id and b.status = 'verified'");
    expect(request).toContain("p.publication_status = 'published'");
    expect(request).toContain("p.expires_at > pg_catalog.clock_timestamp()");
    expect(request).toContain("o.status = 'active'");
    expect(request).toContain("h.chapter_id = target and h.hidden_chapter_id = chapter");
    expect(request).toContain("return public.request_chapter_handshake(partner, p_title, p_purpose, p_data_scope, p_idempotency_key)");
    expect(sql).not.toMatch(/create\s+table|insert\s+into\s+public\.chapter_handshake|create or replace function public\.request_chapter_handshake\(/i);
  });
  it("locks the graph and registry before validating routing without row-lock inversion", () => {
    expect(request.indexOf("perform private.lock_case_graph")).toBeLessThan(request.indexOf("org :="));
    expect(request.indexOf("for share;")).toBeLessThan(request.indexOf("select b.union_org_id into partner"));
    expect(request).toContain("pg_advisory_xact_lock(pg_catalog.hashtextextended(p_idempotency_key::text, 509281))");
    expect(request).not.toMatch(/for update/);
    expect(request).toContain("p_data_scope is null");
  });
  it("publishes only bounded organizational handshake eligibility and a source capability", () => {
    const projection = fnBody(sql, "private.chapter_connection_profile_projection");
    expect(projection).toContain("'eligible', identity ->> 'partnerOrgId' is not null");
    expect(projection).toContain("'partnerOrgId', identity -> 'partnerOrgId'");
    expect(projection).not.toMatch(/requested_by|verified_by|organization_id|email/);
    expect(fnBody(sql, "private.chapter_connection_workspace")).toContain("'canRequestHandshake', coalesce(");
    expect(sql).toContain("grant execute on function public.request_chapter_connection_handshake(text,text,text,text,text,text,uuid) to authenticated;");
  });
});
