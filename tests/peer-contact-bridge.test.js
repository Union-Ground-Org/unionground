import { describe, expect, it } from "vitest";
import {
  PEER_CONTACT_DOWN,
  PEER_CONTACT_UP,
  sanitizePeerContactProjection,
} from "../src/lib/peerContactBridge.js";

const valid = {
  available: true,
  canRequest: true,
  code: "PSG-0123456789ABCDEF0123",
  incoming: [{
    id: "request-1",
    requesterName: "Alex Rivera",
    requesterInitials: "AR",
    createdAt: "2026-08-12T12:00:00Z",
    expiresAt: "2026-08-19T12:00:00Z",
  }],
  outgoing: [{ id: "request-2", status: "pending", createdAt: "2026-08-12T12:01:00Z" }],
  conversations: [{
    id: "conversation-1",
    peerName: "Jordan Lee",
    peerInitials: "JL",
    updatedAt: "2026-08-12T12:02:00Z",
    messages: [{ id: "message-1", sentByMe: false, body: "Private hello", createdAt: "2026-08-12T12:02:00Z" }],
  }],
};

describe("peer contact companion bridge", () => {
  it("uses a dedicated direction for each half of the trusted bridge", () => {
    expect(PEER_CONTACT_DOWN).toBe("sg-peer-contact-data");
    expect(PEER_CONTACT_UP).toBe("sg-peer-contact-data-up");
  });

  it("rebuilds an allowed bounded projection and strips injected identity fields", () => {
    const projection = sanitizePeerContactProjection({
      ...valid,
      email: "never@bridge.invalid",
      incoming: [{ ...valid.incoming[0], address: "not allowed" }],
      conversations: [{ ...valid.conversations[0], peerEmail: "never@bridge.invalid", messages: [{ ...valid.conversations[0].messages[0], senderId: "secret-user" }] }],
    });
    expect(projection).toEqual({ ...valid, unavailable: false });
    expect(JSON.stringify(projection)).not.toContain("never@bridge.invalid");
    expect(JSON.stringify(projection)).not.toContain("secret-user");
  });

  it("accepts the fail-closed empty projection and all server request statuses", () => {
    expect(sanitizePeerContactProjection({ available: false, unavailable: true, canRequest: false, code: "", incoming: [], outgoing: [], conversations: [] }))
      .toEqual({ available: false, unavailable: true, canRequest: false, code: "", incoming: [], outgoing: [], conversations: [] });
    for (const status of ["pending", "accepted", "declined", "expired"]) {
      expect(sanitizePeerContactProjection({ ...valid, outgoing: [{ ...valid.outgoing[0], status }] })?.outgoing[0].status).toBe(status);
    }
  });

  it.each([
    null,
    [],
    { ...valid, available: "yes" },
    { ...valid, canRequest: 1 },
    { ...valid, code: "PSG-too-short" },
    { ...valid, code: "PSG-ZZZZZZZZZZZZZZZZZZZZ" },
    { ...valid, incoming: "request" },
    { ...valid, incoming: Array.from({ length: 21 }, () => valid.incoming[0]) },
    { ...valid, incoming: [{ ...valid.incoming[0], id: "bad id" }] },
    { ...valid, incoming: [{ ...valid.incoming[0], requesterName: "" }] },
    { ...valid, incoming: [{ ...valid.incoming[0], requesterInitials: null }] },
    { ...valid, incoming: [{ ...valid.incoming[0], createdAt: "" }] },
    { ...valid, incoming: [{ ...valid.incoming[0], expiresAt: "" }] },
    { ...valid, outgoing: [{ ...valid.outgoing[0], status: "unknown" }] },
    { ...valid, conversations: [{ ...valid.conversations[0], peerName: "" }] },
    { ...valid, conversations: [{ ...valid.conversations[0], messages: "message" }] },
    { ...valid, conversations: [{ ...valid.conversations[0], messages: [{ ...valid.conversations[0].messages[0], sentByMe: "yes" }] }] },
    { ...valid, conversations: [{ ...valid.conversations[0], messages: [{ ...valid.conversations[0].messages[0], body: "" }] }] },
    { ...valid, conversations: [{ ...valid.conversations[0], messages: Array.from({ length: 101 }, () => valid.conversations[0].messages[0]) }] },
  ])("rejects malformed or unbounded payload %# without partial application", (payload) => {
    expect(sanitizePeerContactProjection(payload)).toBeNull();
  });

  // #9189: the conversation's state survives the bridge; a missing one stays
  // missing (an older server, read as open) and an unknown one is malformed.
  it("keeps each known conversation state and rejects an unknown one", () => {
    for (const state of ["open", "closed", "blocked_by_viewer"]) {
      expect(sanitizePeerContactProjection({ ...valid, conversations: [{ ...valid.conversations[0], state }] }).conversations[0].state).toBe(state);
    }
    expect(sanitizePeerContactProjection(valid).conversations[0]).not.toHaveProperty("state");
    for (const state of ["blocked", "", null, 1]) {
      expect(sanitizePeerContactProjection({ ...valid, conversations: [{ ...valid.conversations[0], state }] })).toBeNull();
    }
  });

  it("rejects oversized and non-serializable graphs", () => {
    expect(sanitizePeerContactProjection({ ...valid, ignored: "x".repeat(1_000_001) })).toBeNull();
    const circular = { ...valid };
    circular.loop = circular;
    expect(sanitizePeerContactProjection(circular)).toBeNull();
  });
});
