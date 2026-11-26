// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { assignMemberCase, loadCaseAssignmentCandidates } from "../src/lib/memberApi.js";

describe("case assignment API", () => {
  it("loads candidates through the selected case boundary", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ userId: "s1", fullName: "Sam", roles: ["steward"] }], error: null });
    await expect(loadCaseAssignmentCandidates({ rpc }, "case-1")).resolves.toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith("list_member_case_assignment_candidates", { p_case_id: "case-1" });
  });

  it("maps blank selections to null and propagates server refusal", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    await assignMemberCase({ rpc }, "case-1", { stewardId: "", coordinatorId: "c1" });
    expect(rpc).toHaveBeenCalledWith("assign_member_case", { p_case_id: "case-1", p_steward: null, p_coordinator: "c1" });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "outside scope" } });
    await expect(assignMemberCase({ rpc }, "case-1", {})).rejects.toThrow("outside scope");
  });
});
