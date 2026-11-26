import { describe, expect, it, vi } from "vitest";
import { grantMemberRole } from "../src/lib/memberApi.js";

describe("admin steward unit grants", () => {
  it("refuses an absent chapter or unit before sending a request", async () => {
    const client = { rpc: vi.fn() };
    for (const scope of [null, "chapter", {}, { chapterId: "chapter" }, { unitId: "unit" }]) await expect(grantMemberRole(client, "member", "steward", scope)).rejects.toThrow("Choose a chapter and unit");
    expect(client.rpc).not.toHaveBeenCalled();
  });
  it("sends only a unit-scoped chapter grant and no carry-over field", async () => {
    const client = { rpc: vi.fn(async () => ({ data: { updated: true }, error: null })) };
    expect(await grantMemberRole(client, "member", "steward", { chapterId: "chapter", unitId: "unit", legacyChapterCoverage: true })).toMatchObject({ granted: true });
    expect(client.rpc).toHaveBeenCalledWith("set_member_access_role", { p_user: "member", p_chapter: "chapter", p_role: "steward", p_enabled: true, p_unit: "unit", p_committee: null });
  });
  it("preserves organization-role behavior for the other roles", async () => {
    const client = { rpc: vi.fn(async () => ({ data: { changed: true }, error: null })) };
    await grantMemberRole(client, "member", "vp");
    expect(client.rpc).toHaveBeenCalledWith("set_member_organization_role", { p_user_id: "member", p_role: "vp", p_enabled: true });
  });
});
