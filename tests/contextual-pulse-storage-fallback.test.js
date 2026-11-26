// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());

describe("quick-check page-life storage fallback", () => {
  it.each(["absent", "read-denied", "write-denied"])("retains one key and remembers consumption with %s storage", async (mode) => {
    const { pulseSessionKey, pulseSessionUsed, markPulseSessionUsed } = await import("../src/features/engagement/contextualPulse.js");
    const values = new Map();
    const storage = mode === "absent" ? null : {
      getItem(key) { if (mode === "read-denied") throw new Error("Blocked"); return values.get(key) ?? null; },
      setItem(key, value) { if (mode === "write-denied") throw new Error("Full"); values.set(key, value); },
    };
    const uuid = vi.fn()
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValue("00000000-0000-4000-8000-000000000002");

    expect(pulseSessionUsed(storage)).toBe(false);
    const first = pulseSessionKey(storage, uuid);
    expect(pulseSessionKey(storage, uuid)).toBe(first);
    markPulseSessionUsed(storage);
    expect(pulseSessionUsed(storage)).toBe(true);
    expect(pulseSessionKey(storage, uuid)).toBe(first);
    expect(uuid).toHaveBeenCalledTimes(1);
  });
});
