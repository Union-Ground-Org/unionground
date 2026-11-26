// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createAdminChapter,
  loadAdminDesk,
  loadAdminMemberDirectory,
  loadAdminOrgStructure,
  updateAdminChapter,
} from "../src/lib/memberApi.js";

function adminClient(overrides = {}) {
  return {
    rpc: vi.fn(async (name) => {
      if (name === "get_staff_roster" || name === "get_admin_events") return { data: [], error: null };
      if (name === "get_admin_member_directory") return { data: { items: [], nextCursor: null }, error: null };
      if (name === "get_admin_org_structure") return { data: { scope: "chapter", chapterId: "wor", canCreateChapter: false, chapters: [] }, error: null };
      return { data: null, error: { message: "optional unavailable" } };
    }),
    ...overrides,
  };
}

describe("admin command center client", () => {
  it("loads the initial directory and organization without inventing unavailable state", async () => {
    const client = adminClient({
      rpc: vi.fn(async (name) => {
        if (name === "get_staff_roster" || name === "get_admin_events") return { data: [], error: null };
        if (name === "get_admin_member_directory") return { data: {
          items: [{ userId: "u1", fullName: "Ana Rivera", initials: "AR", memberSince: 2021, chapterId: "wor", chapterName: "Harborview Care United", roles: ["admin"] }],
          nextCursor: { name: "Ana Rivera", id: "u1" },
          context: { organizationId: "11111111-1111-4111-8111-111111111111", chapterId: "wor" },
        }, error: null };
        if (name === "get_admin_org_structure") return { data: {
          scope: "chapter", chapterId: "wor", canCreateChapter: false,
          chapters: [{ id: "wor", name: "Harborview Care United", region: "Central", isDefault: true, orderIndex: 1, memberCount: 812, staffCount: 6 }],
        }, error: null };
        return { data: null, error: { message: "optional unavailable" } };
      }),
    });
    const desk = await loadAdminDesk(client, "en");
    expect(desk.memberDirectory).toEqual({
      items: [{ userId: "u1", fullName: "Ana Rivera", initials: "AR", memberSince: 2021, chapterId: "wor", chapterName: "Harborview Care United", roles: ["admin"] }],
      nextCursor: { name: "Ana Rivera", id: "u1" },
      // The context the rows were read under, which the CSV export binds to.
      context: { organizationId: "11111111-1111-4111-8111-111111111111", chapterId: "wor" },
    });
    expect(desk.organization.chapters[0]).toMatchObject({ memberCount: 812, staffCount: 6 });
  });

  it("uses explicit null sentinels when either additive command-center read fails", async () => {
    const client = adminClient({
      rpc: vi.fn(async (name) => {
        if (name === "get_staff_roster" || name === "get_admin_events") return { data: [], error: null };
        return { data: null, error: { message: "not deployed" } };
      }),
    });
    const desk = await loadAdminDesk(client);
    expect(desk.memberDirectory).toBeNull();
    expect(desk.organization).toBeNull();
  });

  it("maps keyset paging and clamps the client request to the product page size", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { items: [], nextCursor: null }, error: null });
    const result = await loadAdminMemberDirectory({ rpc }, {
      query: " Ana ", after: { name: "Ana Rivera", id: "00000000-0000-0000-0000-000000000001" }, limit: 25,
    });
    expect(rpc).toHaveBeenCalledWith("get_admin_member_directory", {
      p_query: "Ana",
      p_after_name: "Ana Rivera",
      p_after_id: "00000000-0000-0000-0000-000000000001",
      p_limit: 25,
    });
    expect(result).toEqual({ items: [], nextCursor: null, context: null });
  });

  it("maps organization reads and audited chapter mutations exactly", async () => {
    const rpc = vi.fn(async (name) => ({
      data: name === "get_admin_org_structure" ? {
        chapters: [{ id: "wor", roleCounts: { steward: 2, coordinator: 1, advisor: 0, admin: 1, vp: 0 } }],
      } : { ok: true }, error: null,
    }));
    const organization = await loadAdminOrgStructure({ rpc });
    expect(organization.chapters[0].roleCounts).toEqual({ steward: 2, coordinator: 1, advisor: 0, admin: 1, vp: 0 });
    await createAdminChapter({ rpc }, { id: " bos-2 ", name: " Boston Two ", region: " Metro ", orderIndex: 7 });
    await updateAdminChapter({ rpc }, "bos-2", { name: " Boston 2 ", region: " Metro West ", orderIndex: 8 });
    expect(rpc.mock.calls).toEqual([
      ["get_admin_org_structure"],
      ["create_admin_chapter", { p_id: "bos-2", p_name: "Boston Two", p_region: "Metro", p_order_index: 7 }],
      ["update_admin_chapter", { p_chapter_id: "bos-2", p_name: "Boston 2", p_region: "Metro West", p_order_index: 8 }],
    ]);
  });

  it("surfaces command-center RPC failures through the shared safe error type", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "denied", code: "42501" } });
    await expect(loadAdminMemberDirectory({ rpc }, {})).rejects.toMatchObject({ message: "Member directory: denied", code: "42501" });
    await expect(loadAdminOrgStructure({ rpc })).rejects.toMatchObject({ message: "Organization structure: denied", code: "42501" });
    await expect(createAdminChapter({ rpc }, { id: "x", name: "X", region: "", orderIndex: 1 })).rejects.toMatchObject({ message: "Create chapter: denied", code: "42501" });
  });
});
