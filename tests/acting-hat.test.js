import { afterEach, describe, expect, it } from "vitest";
import { ACTING_HAT_STORAGE_KEY, clearActingHat, entryHatForView, readActingHat, writeActingHat } from "../src/lib/actingHat.js";

// REQ-UG-TYPED-ADDRESS-ROLE-DESK-BOUNCE-20261030: the per-tab record
// of the worn hat, and the hat a typed address opens in.

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

const throwingStorage = {
  getItem() { throw new Error("blocked"); },
  setItem() { throw new Error("quota"); },
  removeItem() { throw new Error("blocked"); },
};

afterEach(() => sessionStorage.clear());

describe("the stored acting hat", () => {
  it("round-trips through the tab's session storage by default", () => {
    writeActingHat("user-1", "steward");
    expect(JSON.parse(sessionStorage.getItem(ACTING_HAT_STORAGE_KEY))).toEqual({ userId: "user-1", hat: "steward" });
    expect(readActingHat()).toEqual({ userId: "user-1", hat: "steward" });
    clearActingHat();
    expect(readActingHat()).toBeNull();
  });

  it("keeps Member as a choice", () => {
    const storage = memoryStorage();
    writeActingHat("user-1", "member", storage);
    expect(readActingHat(storage)).toEqual({ userId: "user-1", hat: "member" });
  });

  it("never writes an unknown hat or a missing account", () => {
    const storage = memoryStorage();
    writeActingHat("user-1", "owner", storage);
    writeActingHat("", "admin", storage);
    writeActingHat(null, "admin", storage);
    expect(storage.getItem(ACTING_HAT_STORAGE_KEY)).toBeNull();
  });

  it.each([
    ["not json", "{"],
    ["not an object", "\"admin\""],
    ["an unknown hat", JSON.stringify({ userId: "user-1", hat: "owner" })],
    ["no account", JSON.stringify({ hat: "admin" })],
    ["an empty account", JSON.stringify({ userId: "", hat: "admin" })],
  ])("reads nothing from %s", (_label, raw) => {
    const storage = memoryStorage();
    storage.setItem(ACTING_HAT_STORAGE_KEY, raw);
    expect(readActingHat(storage)).toBeNull();
  });

  it("tolerates storage that is missing or refuses every call", () => {
    expect(readActingHat(null)).toBeNull();
    expect(readActingHat(throwingStorage)).toBeNull();
    expect(() => writeActingHat("user-1", "admin", throwingStorage)).not.toThrow();
    expect(() => clearActingHat(throwingStorage)).not.toThrow();
    expect(() => writeActingHat("user-1", "admin", null)).not.toThrow();
    expect(() => clearActingHat(null)).not.toThrow();
  });
});

describe("the hat a typed address opens in", () => {
  it("prefers Member when Member opens the page", () => {
    expect(entryHatForView(["admin"], "rights", () => true)).toBe("member");
  });

  it("opens a desk plane in its own held role", () => {
    expect(entryHatForView(["steward", "admin"], "admin", (hat) => hat === "admin")).toBe("admin");
  });

  it("never chooses a hat for a shared staff tool or a plane the account lacks", () => {
    expect(entryHatForView(["vp", "admin"], "tasks", (hat) => hat !== "member")).toBeNull();
    expect(entryHatForView(["vp"], "admin", (hat) => hat === "admin")).toBeNull();
    expect(entryHatForView(["admin"], "admin", () => false)).toBeNull();
  });
});
