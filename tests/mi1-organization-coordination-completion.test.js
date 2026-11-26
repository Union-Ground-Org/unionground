// @vitest-environment node
import { describe, expect, it } from "vitest";
import { forbiddenSupabaseRefsIn } from "../scripts/lib/sibling-deny-list.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const raw = loadMigrationSql("20260828233000_mi1_coordination_decisions_public_microsites");
const sql = stripComments(raw);
const seedRaw = loadMigrationSql("20260828234000_mi1_coordination_pagination_demo_seed");
const seedSql = stripComments(seedRaw);

function body(name) {
  return stripComments(fnBody(sql, name));
}

describe("MI1 organization coordination completion migration", () => {
  it("stores coalition decisions and one organization-scoped vote per participant", () => {
    for (const table of [
      "organization_coalition_decisions",
      "organization_coalition_decision_votes",
    ]) {
      expect(sql).toContain(`create table public.${table}`);
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
    expect(sql).toContain("unique (decision_id, organization_id)");
    expect(body("private.validate_organization_coalition_decision")).toContain("coalition_work_item");
    expect(body("private.inherit_organization_coordination_participants")).toContain("excluded.status = 'active'");
    expect(sql).toContain("create trigger inherit_organization_coordination_participants");
  });

  it("derives coalition authority from active participants and applies a real quorum", () => {
    const propose = body("public.propose_organization_coalition_decision");
    const vote = body("public.vote_organization_coalition_decision");
    expect(propose).toContain("private.current_member_organization()");
    expect(propose).toContain("participant.status = 'active'");
    expect(propose).not.toMatch(/p_organization_id\b/);
    expect(vote).toContain("approval_count >= decision.required_approvals");
    expect(vote).toContain("eligible_count - rejection_count < decision.required_approvals");
    expect(vote).toContain("when 'authorize_work' then 'active'");
  });

  it("connects attachments and takeover evidence to the real public hierarchy", () => {
    for (const table of ["public_chapter_page_attachments", "public_chapter_page_takeovers"]) {
      expect(sql).toContain(`create table public.${table}`);
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
    expect(sql).toMatch(/foreign key \(organization_id, chapter_code, section_slug, page_slug\)\s+references public\.public_chapter_pages/);
    expect(body("public.attach_public_chapter_page_document")).toContain("private.current_member_organization()");
    expect(body("public.take_over_public_chapter_page")).toContain("public.public_chapter_page_takeovers");
  });

  it("publishes only bounded attachment metadata through the anonymous microsite RPC", () => {
    const projection = body("public.get_public_chapter_microsite");
    expect(projection).toContain("public.public_chapter_page_attachments");
    expect(projection).toContain("document.status = 'published'");
    expect(projection).toContain("document.source_url ~ '^https://[^[:space:]]+$'");
    expect(projection).not.toMatch(/'body',\s*document\.body/);
    expect(sql).toMatch(/grant execute on function public\.get_public_chapter_microsite\(text, text\)\s+to anon, authenticated, service_role/i);
  });

  it("keeps every new table read-only to authenticated clients", () => {
    expect(sql).toMatch(/revoke all on public\.%I from public, anon, authenticated/i);
    expect(sql).toMatch(/grant select on public\.%I to authenticated/i);
    expect(sql).not.toMatch(/grant\s+(insert|update|delete|all)[^;]+to authenticated/i);
  });

  it("adds keyset paging without accepting caller-selected organization scope", () => {
    const paging = stripComments(fnBody(seedSql, "public.list_organization_coordination_records"));
    expect(paging).toContain("private.current_member_organization()");
    expect(paging).toContain("limit page_limit + 1");
    expect(paging).toContain("(record.updated_at, record.id) < (p_before_updated_at, p_before_id)");
    expect(paging).not.toMatch(/p_organization_id\b/);
    expect(seedSql).toMatch(/grant execute on function public\.list_organization_coordination_records[\s\S]+to authenticated/i);
  });

  it("extends both guarded SAMPLE lanes with two real pages and symmetric removal", () => {
    expect(seedSql).toContain("auth.role()) <> 'service_role'");
    expect(seedSql).toContain("function_id between 'CR-053' and 'CR-067'");
    expect(seedSql).toContain("('organizationCoordination', 50, 100");
    expect(seedSql).toContain("('organizationCoordinationMessages', 30, 60");
    expect(seedSql).toContain("('publicChapterMicrositePages', 24, 48");
    expect(seedSql).toContain("private.demo_seed_apply_organization_coordination");
    expect(seedSql).toContain("private.demo_seed_remove_organization_coordination");
    expect(seedSql).toContain("outboundDeliveries', 0");
    expect(forbiddenSupabaseRefsIn(seedSql)).toEqual([]);
  });
});
