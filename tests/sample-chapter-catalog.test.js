// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { loadSampleChapterCatalog } from "../src/lib/memberApi.js";

const originalMigration = readFileSync(
  new URL("../supabase/migrations/20260827202915_sample_chapter_catalog.sql", import.meta.url),
  "utf8",
).toLowerCase();
const scaleMigration = readFileSync(
  new URL("../supabase/migrations/20260830145000_sample_chapter_catalog_scale.sql", import.meta.url),
  "utf8",
).toLowerCase();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("SAMPLE chapter catalog boundary", () => {
  it("gates the definer by tenant membership and an applied SAMPLE seed ledger", () => {
    expect(scaleMigration).toContain("security definer\nset search_path = ''");
    expect(scaleMigration).toContain("private.is_organization_member(caller_org)");
    expect(scaleMigration).toContain("from private.uniondemo_runs run");
    expect(scaleMigration).toContain("run.state in ('applied', 'verified')");
    expect(scaleMigration).toContain("chapter.organization_id = caller_org");
    expect(scaleMigration).toContain("revoke all on function private.sample_chapter_catalog()");
  });

  it("aggregates seeded chapter roles without a per-member JSON helper call", () => {
    expect(scaleMigration).toContain("active_chapter_members as materialized");
    expect(scaleMigration).toContain("join public.organization_role_grants role_grant");
    expect(scaleMigration).toContain("join public.member_role_chapters chapter_role");
    expect(scaleMigration).toContain("staff_members as (");
    expect(scaleMigration).not.toContain("private.organization_member_roles(");
  });

  it("exposes only an authenticated security-invoker wrapper", () => {
    expect(originalMigration).toContain("create function public.get_sample_chapter_catalog()");
    expect(originalMigration).toContain("security invoker\nset search_path = ''");
    expect(originalMigration).toContain("revoke all on function public.get_sample_chapter_catalog()");
    expect(originalMigration).toContain("grant execute on function public.get_sample_chapter_catalog()\n  to authenticated");
    const entry = contract.functions.find((item) => item.sig === "public.get_sample_chapter_catalog()");
    expect(entry).toMatchObject({ secdef: false, exec: "authenticated" });
  });

  it("loads the RPC payload and degrades failures or malformed data to no chapters", async () => {
    const rows = [{ id: "chapter-1", name: "DCF Chapter", memberCount: 812, staffCount: 6 }];
    const ok = { rpc: vi.fn().mockResolvedValue({ data: rows, error: null }) };
    expect(await loadSampleChapterCatalog(ok)).toEqual(rows);
    expect(ok.rpc).toHaveBeenCalledWith("get_sample_chapter_catalog");

    const failed = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "unavailable" } }) };
    expect(await loadSampleChapterCatalog(failed)).toEqual([]);
    const malformed = { rpc: vi.fn().mockResolvedValue({ data: { id: "not-an-array" }, error: null }) };
    expect(await loadSampleChapterCatalog(malformed)).toEqual([]);
  });
});
