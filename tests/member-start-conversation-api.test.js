// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { startMemberConversation } from "../src/lib/memberApi.js";

describe("startMemberConversation", () => {
  it("uses one RPC, passes only the first message, and returns server ids", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { conversationId: "c1", messageId: "m1", awardedPoints: 2 }, error: null });
    const from = vi.fn();
    await expect(startMemberConversation({ rpc, from }, "  Help please  ")).resolves.toMatchObject({ conversationId: "c1", messageId: "m1" });
    expect(rpc).toHaveBeenCalledWith("start_member_conversation", { p_body: "  Help please  " });
    expect(from).not.toHaveBeenCalled();
  });
});
