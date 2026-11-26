import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrganizationCoordinationAdapter } from "../src/features/coordination/adapter.js";

const actor = {
  userId: "member-1",
  organizationId: "tamarack",
  membershipStatus: "active",
  selectedHat: "coordinator",
  organizationRoles: ["coordinator"],
  mfaSatisfied: true,
};

// Every adapter intent that generates an operation key. Exercise the public
// methods so a missing entropy source cannot send any of these writes.
const intents = [
  ["create", [{ kind: "mission", title: "Mission" }]],
  ["join", ["record-1"]],
  ["transition", ["record-1", "activate"]],
  ["respond", ["record-1", true]],
  ["message", ["conversation-1", "Update"]],
  ["resource", [{ recordId: "record-1", title: "Guide" }]],
  ["runExport", ["schedule-1"]],
  ["outreach", [{ campaignId: "campaign-1" }]],
  ["inviteOrganization", [{ recordId: "record-1" }]],
  ["respondParticipant", ["record-1", true]],
  ["respondResource", ["resource-1", true]],
  ["assignParticipant", [{ recordId: "record-1" }]],
  ["proposeCoalitionDecision", [{ campaignId: "campaign-1" }]],
  ["voteCoalitionDecision", [{ decisionId: "decision-1" }]],
  ["executeMerge", [{ planId: "plan-1" }]],
  ["takeOverPublicPage", [{ chapterCode: "tamarack" }]],
];

afterEach(() => vi.unstubAllGlobals());

describe("coordination operation keys", () => {
  it("prefers randomUUID without reading fallback entropy", async () => {
    const randomUUID = vi.fn(() => "12345678-1234-4123-8123-123456789abc");
    const getRandomValues = vi.fn();
    vi.stubGlobal("crypto", { randomUUID, getRandomValues });
    const rpc = vi.fn(async () => ({ data: "saved" }));
    await createOrganizationCoordinationAdapter({ rpc }).join(actor, "record-1");
    expect(rpc.mock.calls[0][1].p_idempotency_key).toBe(randomUUID.mock.results[0].value);
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it("uses fresh secure UUIDs for every intent when randomUUID is missing", async () => {
    let seed = 0;
    const getRandomValues = vi.fn(function (bytes) {
      expect(this).toBe(globalThis.crypto);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes).toHaveLength(16);
      bytes.fill(++seed);
      bytes[6] = 255;
      bytes[8] = 255;
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });
    const rpc = vi.fn(async () => ({ data: "saved" }));
    const adapter = createOrganizationCoordinationAdapter({ rpc });
    for (const [method, args] of intents) {
      await adapter[method](actor, ...args);
      await adapter[method](actor, ...args);
    }
    const keys = rpc.mock.calls.map(([, args]) => args.p_idempotency_key);
    expect(keys).toHaveLength(intents.length * 2);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-b[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(keys[0]).toBe("01010101-0101-4f01-bf01-010101010101");
    expect(getRandomValues).toHaveBeenCalledTimes(keys.length);
  });

  it.each([undefined, {}])("refuses every generated-key write without secure randomness (%j)", async (crypto) => {
    vi.stubGlobal("crypto", crypto);
    const rpc = vi.fn(async () => ({ data: "saved" }));
    const adapter = createOrganizationCoordinationAdapter({ rpc });
    for (const [method, args] of intents) {
      await expect(adapter[method](actor, ...args), method).rejects.toThrow("Secure randomness is required for coordination operation keys");
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("preserves caller-supplied create keys on retry without requiring entropy", async () => {
    vi.stubGlobal("crypto", undefined);
    const rpc = vi.fn(async () => ({ data: "saved" }));
    const adapter = createOrganizationCoordinationAdapter({ rpc });
    const input = { kind: "mission", title: "Mission", idempotencyKey: "12345678-1234-4123-8123-123456789abc" };
    await adapter.create(actor, input);
    await adapter.create(actor, input);
    expect(rpc).toHaveBeenCalledTimes(2);
    for (const [, args] of rpc.mock.calls) expect(args.p_idempotency_key).toBe(input.idempotencyKey);
  });
});
