// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { adminSearchRecoveryMembers } from "../src/lib/memberApi.js";

describe("sign-in recovery member lookup", () => {
  it("calls only the name-safe recovery RPC with a trimmed query", async () => {
    const rows = [{ userId: "member-1", fullName: "Maria Fonseca", initials: "MF", memberSince: 2024, roles: [] }];
    const rpc = vi.fn().mockResolvedValue({ data: rows, error: null });
    await expect(adminSearchRecoveryMembers({ rpc }, "  Maria  ")).resolves.toEqual(rows);
    expect(rpc).toHaveBeenCalledWith("admin_search_recovery_members", { p_query: "Maria" });
  });
});
