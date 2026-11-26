// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

// REQ-UG-OFFICER-NOTICES-WITH-READ-RECEIPTS-20261030: officers could
// not post a notice members mark as read, because every broadcast layer
// admitted only stewards, and nobody could see who had read a notice.
const NAME = "20261030203000_officer_notices_with_read_receipts";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const body = (name) => stripComments(fnBody(sql, name));
const PUBLISHERS = "array['steward', 'admin', 'vp']";

describe("officer notices migration", () => {
  it("lets stewards, admins and presidents publish within the existing audience bounds", () => {
    const publish = body("public.publish_member_broadcast");
    expect(publish).toContain(`private.has_organization_role(publisher_org, ${PUBLISHERS})`);
    expect(publish).toContain(`private.member_has_chapter_role(publisher_chapter, ${PUBLISHERS})`);
    // Coordinators and advisors stay out.
    expect(publish).not.toMatch(/'coordinator'|'advisor'/u);
    // The publisher, organization and chapter still come from the session.
    expect(publish).not.toContain("p_organization_id");
    expect(publish).toContain("publisher_org, publisher_chapter, clean_scope");
    expect(publish).toContain("member-broadcast-publish:");
    expect(publish).toContain("then 'Chapter steward'");
    expect(publish).toContain("else 'Union officers'");
    expect(publish).toContain("new_id, sender_label, clean_title");
  });

  // The live publish and retract carry
  // 20260907151000's account-lifecycle entry lock ahead of every
  // authorization read; the replacements must keep it there.
  it("keeps the lifecycle entry lock ahead of authorization in every writer", () => {
    for (const name of ["public.publish_member_broadcast", "public.retract_member_broadcast", "public.resolve_announcement_draft"]) {
      const fn = body(name);
      const lock = fn.indexOf("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);");
      expect(lock, name).toBeGreaterThan(-1);
      expect(lock, name).toBeLessThan(fn.indexOf("declare"));
      expect(lock, name).toBeLessThan(fn.indexOf("member_has_chapter_role"));
    }
  });

  it("widens retract, read counts and event drafts to the same roles and nothing else", () => {
    for (const name of ["public.retract_member_broadcast", "public.get_broadcast_read_counts", "public.get_broadcast_read_counts_for"]) {
      expect(body(name), name).toContain(`private.member_has_chapter_role(private.current_member_chapter(), ${PUBLISHERS})`);
      expect(body(name), name).toContain("organization_id = publisher_org");
    }
    for (const name of ["public.list_announcement_drafts", "public.resolve_announcement_draft"]) {
      expect(body(name), name).toContain(`private.member_has_chapter_role(chapter, ${PUBLISHERS})`);
      expect(body(name), name).toContain("f.organization_id = org and f.chapter_id = chapter");
    }
    expect(body("public.resolve_announcement_draft")).toContain("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[])");
  });

  it("shows a publisher only their own notices and receipts, inside the selected organization", () => {
    for (const name of ["public.list_my_member_notices", "public.get_member_notice_receipts"]) {
      const fn = body(name);
      expect(fn, name).toContain("security definer");
      expect(fn, name).toContain("set search_path = ''");
      expect(fn, name).toContain(`private.member_has_chapter_role(chapter, ${PUBLISHERS})`);
      expect(fn, name).toContain("b.created_by = caller");
      expect(fn, name).toContain("b.organization_id = org");
    }
    expect(body("public.get_member_notice_receipts")).toContain("limit 500");
    // Reads and the audience use one predicate.
    expect(body("public.get_member_notice_receipts")).toContain("private.member_notice_in_audience(receipt.user_id, notice.organization_id, notice.chapter_id, notice.audience_scope)");
    expect(body("private.member_notice_read_count")).toContain("private.member_notice_in_audience(r.user_id, b.organization_id, b.chapter_id, b.audience_scope)");
    expect(body("private.member_notice_audience_count")).toContain("private.member_notice_in_audience(om.user_id, p_organization_id, p_chapter_id, p_audience_scope)");
    expect(body("public.list_my_member_notices")).toContain("least(greatest(coalesce(p_limit, 20), 1), 50)");
    // Sol final on: older notices stay reachable through a cursor.
    expect(body("public.list_my_member_notices")).toContain("(b.published_at, b.id) < (p_before_published, p_before_id)");
    expect(body("public.list_my_member_notices")).toContain("'hasMore', more");
  });

  it("keeps the audience count internal and grants the readers to signed-in callers only", () => {
    for (const sig of ["private.member_notice_in_audience(uuid, uuid, text, text)", "private.member_notice_audience_count(uuid, text, text)", "private.member_notice_read_count(text)"]) {
      expect(code).toContain(`revoke all on function ${sig}\n  from public, anon, authenticated, service_role;`);
    }
    for (const sig of ["public.list_my_member_notices(integer, timestamptz, text)", "public.get_member_notice_receipts(text)"]) {
      expect(code).toContain(`revoke all on function ${sig} from public, anon;`);
      expect(code).toContain(`grant execute on function ${sig} to authenticated, service_role;`);
    }
    expect(code).not.toMatch(/grant[^;]*\bto\b[^;]*\banon\b/iu);
  });
});
