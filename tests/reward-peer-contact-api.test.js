import { describe, expect, it, vi } from "vitest";
import * as memberApi from "../src/lib/memberApi.js";
import {
  listRewardPeerContact,
  requestRewardPeerContact,
  respondRewardPeerContact,
  sendRewardPeerMessage,
} from "../src/lib/memberApi.js";

describe("reward peer contact API", () => {
  it("routes the consent workflow through caller-derived RPCs", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true }, error: null });
    const client = { rpc };

    await listRewardPeerContact(client);
    await requestRewardPeerContact(client, " psg-abcd ");
    await respondRewardPeerContact(client, "request-1", true);
    await sendRewardPeerMessage(client, "conversation-1", " Hello ");

    expect(rpc.mock.calls).toEqual([
      ["list_reward_peer_contact"],
      ["request_reward_peer_contact", { p_contact_code: "PSG-ABCD" }],
      ["respond_reward_peer_contact", { p_request_id: "request-1", p_accept: true }],
      ["send_reward_peer_message", { p_conversation_id: "conversation-1", p_body: "Hello" }],
    ]);
  });

  it("never accepts a target user id, email, name, or chapter from the client", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {}, error: null });
    await requestRewardPeerContact({ rpc }, "PSG-0123456789ABCDEF0123");
    expect(rpc).toHaveBeenCalledWith("request_reward_peer_contact", {
      p_contact_code: "PSG-0123456789ABCDEF0123",
    });
  });

  it("offers no Labs (experimental content) client: it left with the points economy", () => {
    // Union Ground has no reward-gated content. Peer contact stays; the
    // entitlement-gated Labs reader must not come back as a callable export.
    expect(memberApi).not.toHaveProperty("listRewardExperimentalContent");
    expect(Object.keys(memberApi).filter((name) => /experimental/i.test(name))).toEqual([]);
  });
});
