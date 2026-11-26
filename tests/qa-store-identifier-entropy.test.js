// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createInMemoryQaStore } from "../src/features/qa/index.js";

const storeSource = readFileSync(
  fileURLToPath(new URL("../src/features/qa/store.js", import.meta.url)),
  "utf8",
);

function member(overrides = {}) {
  return {
    userId: "user-a",
    organizationId: "org-a",
    organizationStatus: "active",
    membershipStatus: "active",
    chapterId: "ch-a",
    organizationRoles: [],
    chapterRoles: [],
    mfaSatisfied: true,
    selectedHat: "member",
    ...overrides,
  };
}

const questionText = {
  title: "When does overtime start after a forced stay?",
  body: "Night shift was held two hours past the posted end without a written order.",
};

describe("Q&A optimistic identifiers", () => {
  it("draws its salt from the Web Crypto API, not Math.random", () => {
    expect(storeSource).not.toContain("Math.random");
    expect(storeSource).toContain("crypto.randomUUID()");
  });

  it("keeps the prefix and timestamp segments a caller can read", () => {
    const store = createInMemoryQaStore({ clock: { now: () => 1_775_000_000_000 } });
    const asked = store.ask(member(), questionText);
    expect(asked.ok).toBe(true);
    const [prefix, stamp, salt] = asked.value.id.split("_");
    expect(prefix).toBe("q");
    expect(stamp).toBe((1_775_000_000_000).toString(36));
    expect(salt).toMatch(/^[0-9a-f]{8}$/);
  });

  it("does not collide when two records are created inside the same clock tick", () => {
    const store = createInMemoryQaStore({ clock: { now: () => 1_775_000_000_000 } });
    const identifiers = new Set();
    for (let index = 0; index < 64; index += 1) {
      const asked = store.ask(member({ userId: `user-${index}` }), questionText);
      expect(asked.ok).toBe(true);
      identifiers.add(asked.value.id);
    }
    expect(identifiers.size).toBe(64);
  });
});
