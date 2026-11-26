// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("20260822010000_mi1_organization_scope_foundation");
const code = stripComments(sql);
const body = (name) => stripComments(fnBody(sql, name));

describe("MI1 broadcast organization boundary", () => {
  it("derives publisher organization server-side and rejects another organization id argument", () => {
    const publish = body("public.publish_member_broadcast");
    expect(publish).toContain("private.current_member_organization()");
    expect(publish).toContain("audience_scope must be chapter or organization");
    expect(publish).toContain("private.has_organization_role(publisher_org, array['steward'])");
    expect(publish).toContain("organization-wide steward role required");
    expect(publish).toContain("publisher_org, publisher_chapter, clean_scope");
    expect(publish).not.toContain("p_organization_id");
    expect(publish).toContain("organization required");
    const publisherLock = publish.indexOf("member-broadcast-publish:");
    expect(publisherLock).toBeGreaterThan(-1);
    expect(publisherLock).toBeLessThan(publish.indexOf("select count(*) into recent"));
    expect(publisherLock).toBeLessThan(publish.indexOf("insert into public.member_broadcasts"));
    expect(code).toContain("drop function if exists public.publish_member_broadcast(text, text, text)");
  });

  it("requires active organization membership before either broadcast audience branch", () => {
    const visibility = body("private.can_read_member_broadcast");
    const membership = visibility.indexOf("private.is_organization_member(b.organization_id)");
    const organizationAudience = visibility.indexOf("b.audience_scope = 'organization'");
    const chapterAudience = visibility.indexOf("b.audience_scope = 'chapter'");
    expect(membership).toBeGreaterThan(-1);
    expect(membership).toBeLessThan(organizationAudience);
    expect(membership).toBeLessThan(chapterAudience);
    expect(visibility).toContain("m.status = 'active'");
  });

  it("hides ownerless broadcasts from counts, receipts, and task derivation", () => {
    const counts = body("public.get_broadcast_read_counts");
    const countsFor = body("public.get_broadcast_read_counts_for");
    const source = body("public.create_chapter_task_from_source");
    expect(counts).toContain("private.can_read_member_broadcast(b.id)");
    expect(counts).toContain("b.organization_id = publisher_org");
    expect(counts).not.toContain("user_id");
    expect(countsFor).toContain("b.id = any(p_broadcast_ids)");
    expect(countsFor).toContain("private.can_read_member_broadcast(b.id)");
    expect(source).toContain("b.organization_id = caller_org");
    expect(source).toContain("private.can_read_member_broadcast(b.id)");
    expect(code).toContain("can_read_member_broadcast(broadcast_id)");
  });

  it("keeps retract inside the caller's organization", () => {
    expect(body("public.retract_member_broadcast")).toContain("organization_id = publisher_org");
  });
});
